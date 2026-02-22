'use strict';

const { PowerViewHub, Position } = require('./PowerViewHub');

let Accessory, Service, Characteristic, UUIDGen;

const Shade = {
  ROLLER: 1,
  TOP_BOTTOM: 2,
  HORIZONTAL: 3,
  VERTICAL: 4,
};

const ShadeTypes = {
  ROLLER: [1, 5, 42],
  TOP_BOTTOM: [8],
  HORIZONTAL: [18, 23],
  VERTICAL: [16],
};

const SubType = {
  BOTTOM: 'bottom',
  TOP: 'top',
};


module.exports = function(homebridge) {
  Accessory = homebridge.platformAccessory;
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  UUIDGen = homebridge.hap.uuid;

  homebridge.registerPlatform('homebridge-powerview', 'PowerView', PowerViewPlatform, true);
};


class PowerViewPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config;
    this.api = api;
    this.accessories = [];

    if (!config) return;

    const host = config.host || 'powerview-hub.local';

    this.hub = new PowerViewHub(log, host, {
      requestIntervalMs: config.requestIntervalMs || 500,
      requestTimeoutMs: config.requestTimeoutMs || 10000,
      maxRetries: config.maxRetries != null ? config.maxRetries : 2,
      concurrency: config.concurrency || 2,
    });

    this.pollIntervalMs = config.pollIntervalMs || 60000;
    this.verifyCommands = config.verifyCommands !== false;
    this.verifyDelayMs = config.verifyDelayMs || 5000;

    this.forceRollerShades = config.forceRollerShades || [];
    this.forceTopBottomShades = config.forceTopBottomShades || [];
    this.forceHorizontalShades = config.forceHorizontalShades || [];
    this.forceVerticalShades = config.forceVerticalShades || [];

    this.hubName = null;
    this.hubSerialNumber = null;
    this.hubVersion = null;

    this.api.on('didFinishLaunching', () => {
      this.log('PowerView launched (queue: %dms, concurrency: %d, poll: %dms, verify: %s)',
        config.requestIntervalMs || 500, config.concurrency || 2, this.pollIntervalMs, this.verifyCommands);
      this.updateHubInfo();
      this.updateShades(() => {
        this.pollShades();
      });
    });
  }


  // ── Shade type detection ────────────────────────────────────────────

  shadeType(shade) {
    if (this.forceRollerShades.includes(shade.id)) return Shade.ROLLER;
    if (this.forceTopBottomShades.includes(shade.id)) return Shade.TOP_BOTTOM;
    if (this.forceHorizontalShades.includes(shade.id)) return Shade.HORIZONTAL;
    if (this.forceVerticalShades.includes(shade.id)) return Shade.VERTICAL;

    if (ShadeTypes.ROLLER.includes(shade.type)) return Shade.ROLLER;
    if (ShadeTypes.TOP_BOTTOM.includes(shade.type)) return Shade.TOP_BOTTOM;
    if (ShadeTypes.HORIZONTAL.includes(shade.type)) return Shade.HORIZONTAL;
    if (ShadeTypes.VERTICAL.includes(shade.type)) return Shade.VERTICAL;

    this.log('*** Shade %d has unknown type %d, assuming roller ***', shade.id, shade.type);
    return Shade.ROLLER;
  }


  // ── Accessory lifecycle ─────────────────────────────────────────────

  configureAccessory(accessory) {
    this.log('Cached shade %d: %s', accessory.context.shadeId, accessory.displayName);
    accessory.reachable = true;

    if (!accessory.context.shadeType) {
      const service = accessory.getServiceByUUIDAndSubType(Service.WindowCovering, SubType.TOP);
      accessory.context.shadeType = service ? Shade.TOP_BOTTOM : Shade.ROLLER;
    }

    this.configureShadeAccessory(accessory);
  }

  addShadeAccessory(shade) {
    const name = Buffer.from(shade.name, 'base64').toString();
    this.log('Adding shade %d: %s', shade.id, name);

    const uuid = UUIDGen.generate(shade.id.toString());
    const accessory = new Accessory(name, uuid);
    accessory.context.shadeId = shade.id;
    accessory.context.shadeType = this.shadeType(shade);

    this.configureShadeAccessory(accessory);
    this.api.registerPlatformAccessories('homebridge-powerview', 'PowerView', [accessory]);

    return accessory;
  }

  updateShadeAccessory(shade) {
    const accessory = this.accessories[shade.id];
    this.log('Updating shade %d: %s', shade.id, accessory.displayName);

    const newType = this.shadeType(shade);
    if (newType !== accessory.context.shadeType) {
      this.log('Shade changed type %d -> %d', accessory.context.shadeType, newType);
      accessory.context.shadeType = newType;
      this.configureShadeAccessory(accessory);
    }

    return accessory;
  }

  removeShadeAccessory(accessory) {
    this.log('Removing shade %d: %s', accessory.context.shadeId, accessory.displayName);
    this.api.unregisterPlatformAccessories('homebridge-powerview', 'PowerView', [accessory]);
    delete this.accessories[accessory.context.shadeId];
  }

  /**
   * Sets up characteristic callbacks for a shade accessory.
   * No 'get' handlers — HomeKit reads the last value pushed via polling.
   * Only 'set' handlers for user-initiated position changes.
   */
  configureShadeAccessory(accessory) {
    const shadeId = accessory.context.shadeId;
    this.accessories[shadeId] = accessory;

    // Bottom / primary service
    let service = accessory.getServiceByUUIDAndSubType(Service.WindowCovering, SubType.BOTTOM);
    if (!service) {
      service = accessory.addService(Service.WindowCovering, accessory.displayName, SubType.BOTTOM);
    }

    service.getCharacteristic(Characteristic.TargetPosition)
      .removeAllListeners('set')
      .on('set', (val, cb) => this.setPosition(shadeId, Position.BOTTOM, val, cb));

    // Horizontal vanes (Silhouette, Pirouette)
    if (accessory.context.shadeType === Shade.HORIZONTAL) {
      service.getCharacteristic(Characteristic.TargetHorizontalTiltAngle)
        .setProps({ minValue: 0 })
        .removeAllListeners('set')
        .on('set', (val, cb) => this.setPosition(shadeId, Position.VANES, val, cb));
    } else {
      this._removeCharacteristicIfExists(service, Characteristic.TargetHorizontalTiltAngle);
      this._removeCharacteristicIfExists(service, Characteristic.CurrentHorizontalTiltAngle);
    }

    // Vertical vanes (Luminette)
    if (accessory.context.shadeType === Shade.VERTICAL) {
      service.getCharacteristic(Characteristic.TargetVerticalTiltAngle)
        .removeAllListeners('set')
        .on('set', (val, cb) => this.setPosition(shadeId, Position.VANES, val, cb));
    } else {
      this._removeCharacteristicIfExists(service, Characteristic.TargetVerticalTiltAngle);
      this._removeCharacteristicIfExists(service, Characteristic.CurrentVerticalTiltAngle);
    }

    // Top service (top-down/bottom-up shades)
    let topService = accessory.getServiceByUUIDAndSubType(Service.WindowCovering, SubType.TOP);
    if (accessory.context.shadeType === Shade.TOP_BOTTOM) {
      if (!topService) {
        topService = accessory.addService(Service.WindowCovering, accessory.displayName, SubType.TOP);
      }

      topService.getCharacteristic(Characteristic.TargetPosition)
        .removeAllListeners('set')
        .on('set', (val, cb) => this.setPosition(shadeId, Position.TOP, val, cb));
    } else {
      if (topService) accessory.removeService(topService);
    }
  }

  _removeCharacteristicIfExists(service, characteristicType) {
    if (service.testCharacteristic(characteristicType)) {
      const c = service.getCharacteristic(characteristicType);
      service.removeCharacteristic(c);
      service.addOptionalCharacteristic(characteristicType);
    }
  }


  // ── Shade value updates (called by polling and SET responses) ───────

  updateShadeValues(shade, current = false) {
    const accessory = this.accessories[shade.id];
    if (!accessory) return null;

    let positions = null;

    if (shade.positions) {
      this.log('Shade %d positions: %s', shade.id, JSON.stringify(shade.positions));
      positions = {};

      for (let i = 1; shade.positions['posKind' + i]; ++i) {
        const posKind = shade.positions['posKind' + i];
        const hubValue = shade.positions['position' + i];

        if (posKind === Position.BOTTOM) {
          positions[Position.BOTTOM] = Math.round(100 * hubValue / 65535);
          this._updateBottomPosition(accessory, positions[Position.BOTTOM], current);
        }

        if (posKind === Position.VANES && accessory.context.shadeType === Shade.HORIZONTAL) {
          positions[Position.VANES] = Math.round(90 * hubValue / 32767);
          this._updateHorizontalVanes(accessory, positions[Position.VANES], current);
        }

        if (posKind === Position.VANES && accessory.context.shadeType === Shade.VERTICAL) {
          positions[Position.VANES] = 90 - Math.round(180 * hubValue / 65535);
          this._updateVerticalVanes(accessory, positions[Position.VANES], current);
        }

        if (posKind === Position.TOP && accessory.context.shadeType === Shade.TOP_BOTTOM) {
          positions[Position.TOP] = Math.round(100 * hubValue / 65535);
          this._updateTopPosition(accessory, positions[Position.TOP], current);
        }
      }
    }

    if (this.hubVersion) {
      const infoService = accessory.getService(Service.AccessoryInformation);
      if (infoService) {
        infoService
          .setCharacteristic(Characteristic.Manufacturer, 'Hunter Douglas')
          .setCharacteristic(Characteristic.Model, this.hubVersion);
      }
    }

    return positions;
  }

  _updateBottomPosition(accessory, value, current) {
    const service = accessory.getServiceByUUIDAndSubType(Service.WindowCovering, SubType.BOTTOM);
    if (!service || isNaN(value)) return;

    if (current) service.setCharacteristic(Characteristic.CurrentPosition, value);
    service.updateCharacteristic(Characteristic.TargetPosition, value);
    service.setCharacteristic(Characteristic.PositionState, Characteristic.PositionState.STOPPED);

    if (accessory.context.shadeType === Shade.HORIZONTAL) {
      if (current) service.setCharacteristic(Characteristic.CurrentHorizontalTiltAngle, 0);
      service.updateCharacteristic(Characteristic.TargetHorizontalTiltAngle, 0);
    }
    if (accessory.context.shadeType === Shade.VERTICAL) {
      if (current) service.setCharacteristic(Characteristic.CurrentVerticalTiltAngle, 0);
      service.updateCharacteristic(Characteristic.TargetVerticalTiltAngle, 0);
    }
  }

  _updateHorizontalVanes(accessory, value, current) {
    const service = accessory.getServiceByUUIDAndSubType(Service.WindowCovering, SubType.BOTTOM);
    if (!service || isNaN(value)) return;

    if (current) service.setCharacteristic(Characteristic.CurrentPosition, 0);
    service.updateCharacteristic(Characteristic.TargetPosition, 0);
    service.setCharacteristic(Characteristic.PositionState, Characteristic.PositionState.STOPPED);

    if (current) service.setCharacteristic(Characteristic.CurrentHorizontalTiltAngle, value);
    service.updateCharacteristic(Characteristic.TargetHorizontalTiltAngle, value);
  }

  _updateVerticalVanes(accessory, value, current) {
    const service = accessory.getServiceByUUIDAndSubType(Service.WindowCovering, SubType.BOTTOM);
    if (!service) return;

    if (current) service.setCharacteristic(Characteristic.CurrentPosition, 0);
    service.updateCharacteristic(Characteristic.TargetPosition, 0);
    service.setCharacteristic(Characteristic.PositionState, Characteristic.PositionState.STOPPED);

    if (current) service.setCharacteristic(Characteristic.CurrentVerticalTiltAngle, value);
    service.updateCharacteristic(Characteristic.TargetVerticalTiltAngle, value);
  }

  _updateTopPosition(accessory, value, current) {
    const service = accessory.getServiceByUUIDAndSubType(Service.WindowCovering, SubType.TOP);
    if (!service || isNaN(value)) return;

    if (current) service.setCharacteristic(Characteristic.CurrentPosition, value);
    service.updateCharacteristic(Characteristic.TargetPosition, value);
    service.setCharacteristic(Characteristic.PositionState, Characteristic.PositionState.STOPPED);
  }


  // ── Hub communication ───────────────────────────────────────────────

  updateShades(callback) {
    this.hub.getShades((err, shadeData) => {
      if (!err) {
        const newShades = [];
        for (const shade of shadeData) {
          if (!this.accessories[shade.id]) {
            newShades[shade.id] = this.addShadeAccessory(shade);
          } else {
            newShades[shade.id] = this.updateShadeAccessory(shade);
          }
          this.updateShadeValues(shade);
        }

        for (const shadeId in this.accessories) {
          if (!newShades[shadeId]) {
            this.removeShadeAccessory(this.accessories[shadeId]);
          }
        }
      }
      if (callback) callback(err);
    });
  }

  /** Polls all shades on a timer. This is the only source of position updates. */
  pollShades() {
    setTimeout(() => {
      this.updateShades(() => this.pollShades());
    }, this.pollIntervalMs);
  }

  updateHubInfo(callback) {
    this.hub.getUserData((err, userData) => {
      if (!err) {
        this.hubName = Buffer.from(userData.hubName, 'base64').toString();
        this.hubSerialNumber = userData.serialNumber;
        if (userData.firmware && userData.firmware.mainProcessor) {
          this.hubVersion = userData.firmware.mainProcessor.name;
        }

        this.log('Hub: %s (firmware: %s)', this.hubName, this.hubVersion || 'unknown');

        for (const shadeId in this.accessories) {
          this.updateShadeValues({ id: parseInt(shadeId) });
        }
      }
      if (callback) callback(err);
    });
  }


  // ── HomeKit SET handler ─────────────────────────────────────────────

  setPosition(shadeId, position, value, callback) {
    this.log('setPosition %d/%d = %d', shadeId, position, value);

    if (typeof value !== 'number' || isNaN(value) || !isFinite(value)) {
      callback(new Error('Invalid value: ' + value));
      return;
    }

    let hubValue;
    switch (position) {
      case Position.BOTTOM:
      case Position.TOP:
        hubValue = Math.round(65535 * value / 100);
        break;
      case Position.VANES: {
        const accessory = this.accessories[shadeId];
        if (accessory && accessory.context.shadeType === Shade.VERTICAL) {
          hubValue = Math.abs(Math.round(65535 * (value - 90) / 180));
        } else {
          hubValue = Math.round(32767 * value / 90);
        }
        break;
      }
    }

    this.hub.putShade(shadeId, position, hubValue, value, (err, shade) => {
      if (!err) {
        this.updateShadeValues(shade, true);
        callback(null);

        if (this.verifyCommands) {
          this._verifyCommand(shadeId, position, value, hubValue);
        }
      } else {
        callback(err);
      }
    });
  }

  /**
   * After a SET, waits then reads the shade position to confirm it moved.
   * If it didn't, retries the command once.
   */
  _verifyCommand(shadeId, position, targetValue, hubValue) {
    setTimeout(() => {
      this.log('Verify shade %d/%d (target: %d)', shadeId, position, targetValue);

      this.hub.getShade(shadeId, true, (err, shade) => {
        if (err) {
          this.log('Verify read failed for %d/%d: %s', shadeId, position, err);
          return;
        }

        const positions = this.updateShadeValues(shade, true);
        if (!positions) return;

        const actual = positions[position];
        const tolerance = 5;

        if (actual != null && Math.abs(actual - targetValue) > tolerance) {
          this.log('Verify FAILED %d/%d: expected ~%d, got %d. Retrying.',
            shadeId, position, targetValue, actual);

          this.hub.putShade(shadeId, position, hubValue, targetValue, (retryErr, retryShade) => {
            if (!retryErr) {
              this.updateShadeValues(retryShade, true);
              this.log('Retry sent for %d/%d', shadeId, position);
            } else {
              this.log('Retry failed for %d/%d: %s', shadeId, position, retryErr);
            }
          });
        } else {
          this.log('Verify OK %d/%d: %d', shadeId, position, actual);
        }
      });
    }, this.verifyDelayMs);
  }
}
