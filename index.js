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
    });

    this.refreshShades = config.refreshShades !== false;
    this.pollShadesForUpdate = config.pollShadesForUpdate !== false;
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
      this.log('PowerView plugin launched (queue interval: %dms, poll: %dms, verify: %s)',
        config.requestIntervalMs || 500, this.pollIntervalMs, this.verifyCommands);
      this.updateHubInfo();
      if (this.pollShadesForUpdate) {
        this.pollShades();
      } else {
        this.updateShades();
      }
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

  /** Called by Homebridge when loading cached accessories. */
  configureAccessory(accessory) {
    this.log('Cached shade %d: %s', accessory.context.shadeId, accessory.displayName);
    accessory.reachable = true;

    if (!accessory.context.shadeType) {
      const service = accessory.getServiceByUUIDAndSubType(Service.WindowCovering, SubType.TOP);
      accessory.context.shadeType = service ? Shade.TOP_BOTTOM : Shade.ROLLER;
    }

    this.configureShadeAccessory(accessory);
  }

  /** Creates a new shade accessory. */
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

  /** Updates an existing shade accessory type if changed. */
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

  /** Removes a shade accessory. */
  removeShadeAccessory(accessory) {
    this.log('Removing shade %d: %s', accessory.context.shadeId, accessory.displayName);
    this.api.unregisterPlatformAccessories('homebridge-powerview', 'PowerView', [accessory]);
    delete this.accessories[accessory.context.shadeId];
  }

  /** Sets up characteristic callbacks for a shade accessory. */
  configureShadeAccessory(accessory) {
    const shadeId = accessory.context.shadeId;
    this.accessories[shadeId] = accessory;

    // Bottom / primary service
    let service = accessory.getServiceByUUIDAndSubType(Service.WindowCovering, SubType.BOTTOM);
    if (!service) {
      service = accessory.addService(Service.WindowCovering, accessory.displayName, SubType.BOTTOM);
    }

    service.getCharacteristic(Characteristic.CurrentPosition)
      .removeAllListeners('get')
      .on('get', (cb) => this.getPosition(shadeId, Position.BOTTOM, cb));

    service.getCharacteristic(Characteristic.TargetPosition)
      .removeAllListeners('set')
      .on('set', (val, cb) => this.setPosition(shadeId, Position.BOTTOM, val, cb));

    // Horizontal vanes (Silhouette, Pirouette)
    if (accessory.context.shadeType === Shade.HORIZONTAL) {
      service.getCharacteristic(Characteristic.CurrentHorizontalTiltAngle)
        .setProps({ minValue: 0 })
        .removeAllListeners('get')
        .on('get', (cb) => this.getPosition(shadeId, Position.VANES, cb));

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
      service.getCharacteristic(Characteristic.CurrentVerticalTiltAngle)
        .removeAllListeners('get')
        .on('get', (cb) => this.getPosition(shadeId, Position.VANES, cb));

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

      topService.getCharacteristic(Characteristic.CurrentPosition)
        .removeAllListeners('get')
        .on('get', (cb) => this.getPosition(shadeId, Position.TOP, cb));

      topService.getCharacteristic(Characteristic.TargetPosition)
        .removeAllListeners('set')
        .on('set', (val, cb) => this.setPosition(shadeId, Position.TOP, val, cb));
    } else {
      if (topService) accessory.removeService(topService);
    }
  }

  /** Helper: safely remove a characteristic if it exists. */
  _removeCharacteristicIfExists(service, characteristicType) {
    if (service.testCharacteristic(characteristicType)) {
      const c = service.getCharacteristic(characteristicType);
      service.removeCharacteristic(c);
      service.addOptionalCharacteristic(characteristicType);
    }
  }


  // ── Shade value updates ─────────────────────────────────────────────

  /** Parses shade positions from hub data and updates HomeKit characteristics. */
  updateShadeValues(shade, current = false) {
    const accessory = this.accessories[shade.id];
    if (!accessory) return null;

    let positions = null;

    if (shade.positions) {
      this.log('Set for', shade.id, { positions: shade.positions });
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

    // Update accessory information.
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

    // Reset vanes when shade position changes.
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

    // Vane position implies shade is closed.
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

  /** Discovers all shades and updates accessories. */
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

  /** Periodically polls shades for position changes. */
  pollShades() {
    this.updateShades((err) => {
      setTimeout(() => this.pollShades(), this.pollIntervalMs);
    });
  }

  /** Gets hub information at startup. */
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

  /** Gets a single shade's current state and updates values. */
  updateShade(shadeId, refresh, callback) {
    this.hub.getShade(shadeId, refresh, (err, shade) => {
      if (!err) {
        const positions = this.updateShadeValues(shade);
        const timedOut = refresh ? shade.timedOut : null;
        if (callback) callback(null, positions, timedOut);
      } else {
        this.log('Error getting shade %d: %s', shadeId, err);
        if (callback) callback(err);
      }
    });
  }

  /** Gets a single shade position, with error handling. */
  updatePosition(shadeId, position, refresh, callback) {
    this.updateShade(shadeId, refresh, (err, positions, timedOut) => {
      if (err) {
        if (callback) callback(err);
        this.log('Error %d/%d: %s', shadeId, position, err);
        return;
      }

      if (refresh && timedOut) {
        this.log('Timeout for %d/%d', shadeId, position);
        if (callback) callback(new Error('Timed out'));
        return;
      }

      if (!positions) {
        this.log('Hub did not return positions for %d/%d', shadeId, position);
      }

      if (callback) {
        if (positions && typeof positions[position] === 'number' && isFinite(positions[position])) {
          this.log('updatePosition %d/%d: %d', shadeId, position, positions[position]);
          callback(null, positions[position]);
        } else {
          this.log('Invalid position value for %d/%d, defaulting to 0', shadeId, position);
          callback(null, 0);
        }
      }
    });
  }


  // ── HomeKit characteristic callbacks ────────────────────────────────

  /** Characteristic callback for CurrentPosition.get */
  getPosition(shadeId, position, callback) {
    this.log('getPosition %d/%d', shadeId, position);

    this.updatePosition(shadeId, position, this.refreshShades, (err, value) => {
      if (!err) {
        // If not refreshing by default, try again with a refresh if no value.
        if (!this.refreshShades && value == null) {
          this.log('refresh %d/%d', shadeId, position);
          this.updatePosition(shadeId, position, true, callback);
        } else {
          callback(null, value);
        }
      } else {
        callback(err);
      }
    });
  }

  /** Characteristic callback for TargetPosition.set */
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

        // Verify the command was applied after a delay.
        if (this.verifyCommands) {
          this._verifyCommand(shadeId, position, value, hubValue);
        }
      } else {
        callback(err);
      }
    });
  }

  /**
   * After a SET command, waits then re-reads the shade position.
   * If the shade didn't move, retries the command once.
   */
  _verifyCommand(shadeId, position, targetValue, hubValue) {
    setTimeout(() => {
      this.log('Verifying shade %d/%d (target: %d)', shadeId, position, targetValue);

      this.updatePosition(shadeId, position, true, (err, currentValue) => {
        if (err) {
          this.log('Verify read failed for %d/%d: %s', shadeId, position, err);
          return;
        }

        const tolerance = 5; // allow 5% tolerance
        if (Math.abs(currentValue - targetValue) > tolerance) {
          this.log(
            'Shade %d/%d verify FAILED: expected ~%d, got %d. Retrying command.',
            shadeId, position, targetValue, currentValue,
          );

          this.hub.putShade(shadeId, position, hubValue, targetValue, (retryErr, shade) => {
            if (!retryErr) {
              this.updateShadeValues(shade, true);
              this.log('Shade %d/%d retry command sent', shadeId, position);
            } else {
              this.log('Shade %d/%d retry failed: %s', shadeId, position, retryErr);
            }
          });
        } else {
          this.log('Shade %d/%d verify OK: %d', shadeId, position, currentValue);
        }
      });
    }, this.verifyDelayMs);
  }
}
