import { Request, Response, Router } from "express";
import type { Express } from "express";
import { Server } from "http";
import { z } from "zod";
import { storage } from "./storage";
import { deviceMonitor } from "./device-monitor";
import { setupAuth, isAuthenticated } from "./auth";
import {
  insertDeviceSchema,
  insertDeviceLocationSchema,
  insertDeviceCommandSchema,
  insertGeofenceSchema,
  insertSystemLogSchema,
  CommandType,
  DeviceStatus,
  Device,
} from '@shared/schema';
import { Config } from 'tailwind-merge';

const router = Router();

// Health Check Endpoint for Raspberry Pi monitoring
router.get('/api/health', async (req: Request, res: Response) => {
  try {
    // Check database connection
    const dbCheck = await storage.getAllDevices();

    // System info
    const healthStatus = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      database: 'connected',
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      version: '1.0.0',
      environment: process.env.NODE_ENV || 'development',
    };

    res.json(healthStatus);
  } catch (error) {
    console.error('Health check failed:', error);
    res.status(503).json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      error: 'Database connection failed',
    });
  }
});

// Direct HTTP Endpoints for Arduino Devices
router.get('/api/ping', (req: Request, res: Response) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    message: 'GPS Tracker Server is running',
  });
});

router.get(
  '/api/device/:deviceId/exists',
  async (req: Request, res: Response) => {
    try {
      const { deviceId } = req.params;
      const exists = await storage.checkDeviceExists(deviceId);
      res.json({ exists });
    } catch (error) {
      console.error('Device exists error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.post('/api/device/register', async (req: Request, res: Response) => {
  try {
    const deviceData = {
      ...req.body,
      config: {
        heartbeatInterval: 30000, // 30 secondi - quanto spesso "telefona a casa" + riceve comandi
        lostModeInterval: 15000, // 15 secondi - quanto spesso GPS quando smarrito
        gpsReadInterval: 0, // 0 = OFF - quanto spesso GPS per geofencing
        lowBatteryThreshold: 15.0, // 15% - soglia batteria bassa
      },
    };

    const validatedData = insertDeviceSchema.parse(deviceData);
    const device = await storage.createDevice(validatedData);

    await storage.addSystemLog({
      deviceId: device.id,
      level: 'info',
      category: 'system',
      message: `Device registered with default config: ${device.deviceName} (${device.deviceId})`,
      metadata: {
        defaultConfig: {
          heartbeatInterval: 30000,
          lostModeInterval: 15000,
          gpsReadInterval: 0,
          lowBatteryThreshold: 15.0,
        },
      },
    });

    console.log(
      `✅ New device registered: ${device.deviceId} with default config`
    );

    res.status(201).json(device);
  } catch (error) {
    console.error('Device register error:', error);
    res.status(400).json({ error: 'Invalid device data' });
  }
});

router.post(
  '/api/device/:deviceId/location',
  async (req: Request, res: Response) => {
    try {
      const { deviceId } = req.params;

      const device = await storage.getDeviceByDeviceId(deviceId);
      if (!device) {
        // ✅ INVECE DI 404, INVIA COMANDO REBOOT
        console.log(
          `Device ${deviceId} attempted location update but not found - sending reboot command`
        );

        return res.status(200).json({
          success: false,
          action: 'reboot',
          reason: 'device_not_registered',
          message:
            'Device not found in database. Location not saved. Please reboot to re-register.',
          commands: [
            {
              id: `reboot-${Date.now()}`,
              commandType: 'reboot',
              commandData: {
                reason: 'device_not_registered',
                delay: 10000, // 10 secondi di delay per permettere di finire invio GPS
              },
              status: 'pending',
              createdAt: new Date().toISOString(),
            },
          ],
        });
      }

      const locationData = {
        deviceId: device.id,
        latitude: String(req.body.latitude),
        longitude: String(req.body.longitude),
        altitude: req.body.altitude ? String(req.body.altitude) : null,
        speed: req.body.speed ? String(req.body.speed) : null,
        heading: req.body.heading ? String(req.body.heading) : null,
        satellites: req.body.satellites ? String(req.body.satellites) : null,
        hdop: req.body.hdop ? String(req.body.hdop) : null,
        batteryLevel: req.body.batteryLevel || null,
        signalQuality: req.body.signalQuality || null,
        networkOperator: req.body.networkOperator || null,
        timestamp: new Date(),
      };

      const validatedLocation = insertDeviceLocationSchema.parse(locationData);
      const location = await storage.addDeviceLocation(validatedLocation);

      await deviceMonitor.updateDeviceActivity(deviceId);

      await checkGeofencing(
        device.id,
        parseFloat(req.body.latitude),
        parseFloat(req.body.longitude)
      );

      res.status(201).json(location);
    } catch (error) {
      console.error('Device location error:', error);
      res.status(400).json({ error: 'Invalid location data' });
    }
  }
);

router.post(
  '/api/device/:deviceId/heartbeat',
  async (req: Request, res: Response) => {
    try {
      const { deviceId } = req.params;
      const { status, batteryLevel, signalQuality, gps, network } = req.body;

      const device = await storage.getDeviceByDeviceId(deviceId);
      if (!device) {
        // INVECE DI 404, INVIA COMANDO REBOOT
        console.log(
          `Device ${deviceId} not found in database - sending reboot command`
        );

        return res.status(200).json({
          success: false,
          action: 'reboot',
          reason: 'device_not_registered',
          message:
            'Device not found in database. Please reboot to re-register.',
          commands: [
            {
              id: `reboot-${Date.now()}`,
              commandType: 'reboot',
              commandData: {
                reason: 'device_not_registered',
                delay: 5000, // 5 secondi di delay
              },
              status: 'pending',
              createdAt: new Date().toISOString(),
            },
          ],
        });
      }

      await deviceMonitor.updateDeviceActivity(deviceId);

      await storage.addStatusHistory({
        deviceId: device.id,
        status,
        batteryLevel: batteryLevel || null,
        netSignalQuality: network['signalQuality'] || null,
        netOperator: network['operator'] || null,
        lostMode: gps['lostModeActive'],
        geofencingMode: gps['geofenceActive'],
        gpsHdop: gps['hdop'],
        gpsSatellites: gps['satellites'],
        lastGpsReadAttempt: gps['lastReadAttempt'],
      });

      const pendingCommands = await storage.getPendingCommandsByDevice(
        device.id
      );

      res.json({
        success: true,
        timestamp: new Date().toISOString(),
        config: device.config || {},
        commands: pendingCommands,
      });
    } catch (error) {
      console.error('Device heartbeat error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.post(
  '/api/device/:deviceId/commands/:commandId/ack',
  async (req: Request, res: Response) => {
    try {
      const { commandId } = req.params;
      const { status } = req.body;

      const updated = await storage.updateCommandStatus(
        commandId,
        status || 'acknowledged',
        new Date()
      );

      if (!updated) {
        return res.status(404).json({ error: 'Command not found' });
      }

      res.json({ success: true, timestamp: new Date().toISOString() });
    } catch (error) {
      console.error('Proxy error - command ack:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// Device Registration & Discovery APIs (protected)
router.get(
  '/api/devices/:deviceId/exists',
  isAuthenticated,
  async (req: Request, res: Response) => {
    try {
      const { deviceId } = req.params;
      const exists = await storage.checkDeviceExists(deviceId);
      res.json({ exists });
    } catch (error) {
      console.error('Check device exists error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.post('/api/device/register', async (req: Request, res: Response) => {
  try {
    const deviceData = {
      ...req.body,
      config: {
        heartbeatInterval: 30000, // 30 secondi
        gpsReadInterval: 20000, // 20 secondi
        lostModeInterval: 5000, // 5 secondi in lost mode
        lowBatteryThreshold: 15,
      },
    };

    const validatedDevice = insertDeviceSchema.parse(deviceData);

    // Check if device already exists
    const existingDevice = await storage.getDeviceByDeviceId(
      validatedDevice.deviceId
    );

    if (existingDevice) {
      // Update existing device with new data if needed
      const updatedDevice = await storage.updateDevice(existingDevice.id, {
        ...validatedDevice,
        lastSeen: new Date(),
        status: 'online',
      });

      await storage.addSystemLog({
        deviceId: existingDevice.id,
        userId: req.user?.id || null, // userId è opzionale
        level: 'info',
        category: 'system',
        message: 'Device re-registered',
        metadata: { deviceData: validatedDevice },
      });

      return res.json(updatedDevice);
    }

    // Create new device
    const device = await storage.createDevice(validatedDevice);

    await storage.addSystemLog({
      deviceId: device.id,
      userId: req.user?.id || null, // userId è opzionale
      level: 'info',
      category: 'system',
      message: 'New device registered',
      metadata: { deviceData: validatedDevice },
    });

    res.status(201).json(device);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res
        .status(400)
        .json({ error: 'Invalid device data', details: error.errors });
    }
    console.error('Device registration error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/api/devices/:deviceId', async (req: Request, res: Response) => {
  try {
    const { deviceId } = req.params;
    const device = await storage.getDeviceByDeviceId(deviceId);

    if (!device) {
      return res.status(404).json({ error: 'Device not found' });
    }

    res.json(device);
  } catch (error) {
    console.error('Get device error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get(
  '/api/devices/:deviceId/config',
  async (req: Request, res: Response) => {
    try {
      const { deviceId } = req.params;
      const device = await storage.getDeviceByDeviceId(deviceId);

      if (!device) {
        return res.status(404).json({ error: 'Device not found' });
      }

      // ✅ ESTRAI I 4 PARAMETRI CONFIGURABILI E APPLICA DEFAULTS SE MANCANTI
      const config: any = device.config;

      const responseConfig = {
        // === I 4 PARAMETRI CONFIGURABILI ===
        heartbeatInterval: config.heartbeatInterval,
        lostModeInterval: config.lostModeInterval,
        gpsReadInterval: config.gpsReadInterval,
        lowBatteryThreshold: config.lowBatteryThreshold,
      };

      res.json({
        config: responseConfig,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error('Get device config error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.put('/api/devices/:deviceId', async (req: Request, res: Response) => {
  try {
    const { deviceId } = req.params;
    const device = await storage.getDeviceByDeviceId(deviceId);

    if (!device) {
      return res.status(404).json({ error: 'Device not found' });
    }

    const updatedDevice = await storage.updateDevice(device.id, req.body);
    res.json(updatedDevice);
  } catch (error) {
    console.error('Update device error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/api/devices', async (req: Request, res: Response) => {
  try {
    const devices = await storage.getAllDevices();
    res.json(devices);
  } catch (error) {
    console.error('Get devices error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Device Status & Live Data APIs
router.post(
  '/api/devices/:deviceId/heartbeat',
  async (req: Request, res: Response) => {
    try {
      const { deviceId } = req.params;
      const device = await storage.getDeviceByDeviceId(deviceId);

      if (!device) {
        return res.status(404).json({ error: 'Device not found' });
      }

      const { batteryLevel, signalQuality, status, networkOperator } = req.body;

      // Update device status
      await storage.updateDevice(device.id, {
        status: status || 'online',
        lastSeen: new Date(),
      });

      // Add status history if status changed
      if (status && status !== device.status) {
        await storage.addStatusHistory({
          deviceId: device.id,
          status,
          previousStatus: device.status,
          batteryLevel: batteryLevel ? String(batteryLevel) : null,
          signalQuality: signalQuality ? Number(signalQuality) : null,
        });
      }

      res.json({ success: true });
    } catch (error) {
      console.error('Heartbeat error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.get(
  '/api/devices/:deviceId/status',
  async (req: Request, res: Response) => {
    try {
      const { deviceId } = req.params;
      const device = await storage.getDeviceByDeviceId(deviceId);

      if (!device) {
        return res.status(404).json({ error: 'Device not found' });
      }

      const latestLocation = await storage.getLatestLocation(device.id);
      const unreadAlerts = await storage.getUnreadAlertsCount(device.id);

      res.json({
        device,
        latestLocation,
        unreadAlertsCount: unreadAlerts,
      });
    } catch (error) {
      console.error('Get device status error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.post(
  '/api/devices/:deviceId/location',
  async (req: Request, res: Response) => {
    try {
      const { deviceId } = req.params;
      const device = await storage.getDeviceByDeviceId(deviceId);

      if (!device) {
        return res.status(404).json({ error: 'Device not found' });
      }

      const locationData = insertDeviceLocationSchema.parse({
        ...req.body,
        deviceId: device.id,
        timestamp: new Date(req.body.timestamp || Date.now()),
      });

      const location = await storage.addDeviceLocation(locationData);

      // Update device last seen
      await storage.updateDevice(device.id, { lastSeen: new Date() });

      // Check geofencing (simplified for now)
      await checkGeofencing(
        device.id,
        parseFloat(locationData.latitude),
        parseFloat(locationData.longitude)
      );

      res.status(201).json(location);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res
          .status(400)
          .json({ error: 'Invalid location data', details: error.errors });
      }
      console.error('Add location error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.get(
  '/api/devices/:deviceId/history',
  async (req: Request, res: Response) => {
    try {
      const { deviceId } = req.params;
      const device = await storage.getDeviceByDeviceId(deviceId);

      if (!device) {
        return res.status(404).json({ error: 'Device not found' });
      }

      const limit = parseInt(req.query.limit as string) || 100;
      const locations = await storage.getDeviceLocations(device.id, limit);

      res.json(locations);
    } catch (error) {
      console.error('Get device history error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.get(
  '/api/devices/:deviceId/status-history',
  async (req: Request, res: Response) => {
    try {
      const { deviceId } = req.params;
      const device = await storage.getDeviceByDeviceId(deviceId);

      if (!device) {
        return res.status(404).json({ error: 'Device not found' });
      }

      const limit = parseInt(req.query.limit as string) || 100;
      const history = await storage.getStatusHistory(device.id, limit);

      res.json(history);
    } catch (error) {
      console.error('Get device status history error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.post(
  '/api/devices/:deviceId/commands',
  async (req: Request, res: Response) => {
    try {
      const { deviceId } = req.params;
      const { commandType, payload } = req.body;

      const device = await storage.getDeviceByDeviceId(deviceId);
      if (!device) {
        return res.status(404).json({ error: 'Device not found' });
      }

      let commandData = payload;

      // Check for pending commands
      const pendingCommands = await storage.getPendingCommandsByDevice(
        device.id
      );
      const hasPendingCommand = pendingCommands.some(
        (cmd) => cmd.commandType === commandType && cmd.status === 'pending'
      );

      if (hasPendingCommand) {
        return res.status(409).json({
          error: 'Command already pending',
          message:
            'There is already a pending command of this type for this device',
        });
      }

      // Crea il comando
      const command = await storage.createDeviceCommand({
        deviceId: device.id,
        commandType: commandType as CommandType,
        commandData: JSON.stringify(commandData),
        status: 'pending',
        userId: req.user?.id || null,
      });

      await storage.addSystemLog({
        deviceId: device.id,
        userId: req.user?.id || null,
        level: 'info',
        category: 'command',
        message: `Command created: ${commandType}`,
        metadata: {
          commandId: command.id,
          commandData,
          source: req.user?.id ? 'web_interface' : 'direct_api',
        },
      });

      console.log(`✅ Command created: ${commandType} for device ${deviceId}`);
      res.status(201).json(command);
    } catch (error) {
      console.error('Create device command error:', error);

      // Log dettagliato dell'errore per debug
      if (error instanceof Error) {
        console.error('Error details:', {
          message: error.message,
          stack: error.stack,
          requestBody: req.body,
        });
      }

      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

router.post(
  '/api/devices/:deviceId/commands/:commandId/ack',
  async (req: Request, res: Response) => {
    try {
      const { deviceId, commandId } = req.params;
      const { status } = req.body;

      const device = await storage.getDeviceByDeviceId(deviceId);
      if (!device) {
        return res.status(404).json({ error: 'Device not found' });
      }

      // Try to update command status first
      let success = await storage.updateCommandStatus(commandId, status);

      if (!success) {
        return res.status(404).json({ error: 'Command not found' });
      }

      // Se il comando è executed, conferma l'applicazione della config
      if (status === 'executed') {
        const commands = await storage.getPendingCommandsByDevice(device.id);
        const command = commands.find((cmd) => cmd.id === commandId);

        if (
          command &&
          command.commandType === 'update_config' &&
          command.commandData
        ) {
          await storage.updateDevice(device.id, {
            config: command.commandData,
            updatedAt: new Date(),
          });

          await storage.addSystemLog({
            deviceId: device.id,
            level: 'info',
            category: 'config',
            message: `Configuration successfully applied by device`,
            metadata: {
              commandId: command.id,
              appliedConfig: command.commandData,
            } as Record<string, any>,
          });
        }
      }

      res.json({
        success: true,
        timestamp: new Date().toISOString(),
        status: status,
      });
    } catch (error) {
      console.error('Command ack error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// Geofence APIs
router.post(
  '/api/devices/:deviceId/geofences',
  async (req: Request, res: Response) => {
    try {
      const { deviceId } = req.params;
      const device = await storage.getDeviceByDeviceId(deviceId);

      if (!device) {
        return res.status(404).json({ error: 'Device not found' });
      }

      // Crea la geofence
      const geofenceData = {
        ...req.body,
        deviceId: device.id,
      };

      const validatedGeofence = insertGeofenceSchema.parse(geofenceData);
      const geofence = await storage.createGeofence(validatedGeofence);

      // ✅ CONTROLLA SE È LA PRIMA GEOFENCE
      const allGeofences = await storage.getGeofencesByDevice(device.id);
      const isFirstGeofence = allGeofences.length === 1;

      if (isFirstGeofence) {
        try {
          const command = await storage.createDeviceCommand({
            deviceId: device.id,
            commandType: 'enable_geofence_monitoring',
            commandData: JSON.stringify({
              reason: 'geofence_created',
              geofenceId: geofence.id,
            }),
            status: 'pending',
          });

          // Log di sistema
          await storage.addSystemLog({
            deviceId: device.id,
            level: 'info',
            category: 'geofence',
            message: `First geofence created - GPS monitoring enabled automatically (Command: ${command.id})`,
            metadata: {
              geofenceId: geofence.id,
              commandId: command.id,
              note: 'Device will use gpsReadInterval from config',
            },
          });

          console.log(
            `✅ Geofencing auto-enabled for device ${deviceId} - Command ${command.id} sent (uses config interval)`
          );

          res.status(201).json({
            ...geofence,
            autoCommand: {
              id: command.id,
              type: 'enable_geofence_monitoring',
              message:
                'GPS monitoring automatically enabled using configured interval',
            },
          });
        } catch (commandError) {
          console.error(
            '❌ Error creating auto geofencing command:',
            commandError
          );

          res.status(201).json({
            ...geofence,
            warning:
              'Geofence created but failed to enable GPS monitoring automatically',
          });
        }
      } else {
        // Non è la prima geofence, GPS già attivo
        console.log(
          `📍 Additional geofence created for device ${deviceId} - GPS already active`
        );

        res.status(201).json({
          ...geofence,
          message: 'Geofence added to existing monitoring',
        });
      }
    } catch (error) {
      console.error('Create geofence error:', error);
      res.status(400).json({ error: 'Invalid geofence data' });
    }
  }
);

router.post(
  '/api/devices/:deviceId/geofences',
  async (req: Request, res: Response) => {
    try {
      const { deviceId } = req.params;
      const device = await storage.getDeviceByDeviceId(deviceId);

      if (!device) {
        return res.status(404).json({ error: 'Device not found' });
      }

      // Crea la geofence
      const geofenceData = {
        ...req.body,
        deviceId: device.id,
      };

      const validatedGeofence = insertGeofenceSchema.parse(geofenceData);
      const geofence = await storage.createGeofence(validatedGeofence);

      // ✅ CONTROLLA SE È LA PRIMA GEOFENCE
      const allGeofences = await storage.getGeofencesByDevice(device.id);
      const isFirstGeofence = allGeofences.length === 1; // Appena creata

      if (isFirstGeofence) {
        // ✅ INVIA COMANDO AUTOMATICO enable_geofence_monitoring
        try {
          const command = await storage.createDeviceCommand({
            deviceId: device.id,
            commandType: 'enable_geofence_monitoring',
            commandData: JSON.stringify({
              interval: 30000, // 30 secondi fisso
              reason: 'geofence_created',
              geofenceId: geofence.id,
            }),
            status: 'pending',
          });

          // Log di sistema
          await storage.addSystemLog({
            deviceId: device.id,
            level: 'info',
            category: 'geofence',
            message: `First geofence created - GPS monitoring enabled automatically (Command: ${command.id})`,
            metadata: {
              geofenceId: geofence.id,
              commandId: command.id,
              gpsInterval: 30000,
            },
          });

          console.log(
            `✅ Geofencing auto-enabled for device ${deviceId} - Command ${command.id} sent`
          );

          res.status(201).json({
            ...geofence,
            autoCommand: {
              id: command.id,
              type: 'enable_geofence_monitoring',
              message: 'GPS monitoring automatically enabled',
            },
          });
        } catch (commandError) {
          console.error(
            '❌ Error creating auto geofencing command:',
            commandError
          );

          // Geofence creata comunque, ma comando fallito
          res.status(201).json({
            ...geofence,
            warning:
              'Geofence created but failed to enable GPS monitoring automatically',
          });
        }
      } else {
        // Non è la prima geofence, GPS già attivo
        console.log(
          `📍 Additional geofence created for device ${deviceId} - GPS already active`
        );

        res.status(201).json({
          ...geofence,
          message: 'Geofence added to existing monitoring',
        });
      }
    } catch (error) {
      console.error('Create geofence error:', error);
      res.status(400).json({ error: 'Invalid geofence data' });
    }
  }
);

// ===== DELETE GEOFENCE - CON COMANDO AUTOMATICO =====
router.delete(
  '/api/geofences/:geofenceId',
  async (req: Request, res: Response) => {
    try {
      const { geofenceId } = req.params;

      // Trova la geofence da eliminare
      const geofence = await storage.getGeofenceByGeofenceId(geofenceId);
      if (!geofence) {
        return res.status(404).json({ error: 'Geofence not found' });
      }

      const device = await storage.getDeviceByDeviceId(geofence.deviceId);
      if (!device) {
        return res.status(404).json({ error: 'Device not found' });
      }

      // ✅ CONTROLLA QUANTE GEOFENCE RIMANGONO
      const allGeofences = await storage.getGeofencesByDevice(
        geofence.deviceId
      );
      const isLastGeofence = allGeofences.length === 1;

      // Elimina la geofence
      const success = await storage.deleteGeofence(geofenceId);
      if (!success) {
        return res.status(404).json({ error: 'Failed to delete geofence' });
      }

      if (isLastGeofence) {
        // ✅ COMANDO DISABLE SENZA DATI EXTRA
        try {
          const command = await storage.createDeviceCommand({
            deviceId: geofence.deviceId,
            commandType: 'disable_geofence_monitoring',
            commandData: JSON.stringify({
              reason: 'last_geofence_deleted',
              deletedGeofenceId: geofence.id,
            }),
            status: 'pending',
          });

          // Log di sistema
          await storage.addSystemLog({
            deviceId: geofence.deviceId,
            level: 'info',
            category: 'geofence',
            message: `Last geofence deleted - GPS monitoring disabled automatically (Command: ${command.id})`,
            metadata: {
              deletedGeofenceId: geofence.id,
              commandId: command.id,
            },
          });

          console.log(
            `✅ Geofencing auto-disabled for device ${device.deviceId} - Command ${command.id} sent`
          );

          res.json({
            success: true,
            message: 'Last geofence deleted - GPS monitoring disabled',
            autoCommand: {
              id: command.id,
              type: 'disable_geofence_monitoring',
              message: 'GPS monitoring automatically disabled',
            },
          });
        } catch (commandError) {
          console.error(
            '❌ Error creating auto disable command:',
            commandError
          );

          res.json({
            success: true,
            warning:
              'Geofence deleted but failed to disable GPS monitoring automatically',
          });
        }
      } else {
        // Non è l'ultima geofence, GPS rimane attivo
        console.log(
          `📍 Geofence deleted for device ${device.deviceId} - GPS remains active for other zones`
        );

        res.json({
          success: true,
          message:
            'Geofence deleted - GPS monitoring continues for remaining zones',
        });
      }
    } catch (error) {
      console.error('Delete geofence error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ===== HELPER FUNCTION - FORZA SYNC GEOFENCING =====
router.post(
  '/api/devices/:deviceId/sync-geofencing',
  async (req: Request, res: Response) => {
    try {
      const { deviceId } = req.params;
      const device = await storage.getDeviceByDeviceId(deviceId);

      if (!device) {
        return res.status(404).json({ error: 'Device not found' });
      }

      // Conta geofence attive
      const geofences = await storage.getGeofencesByDevice(device.id);
      const hasGeofences = geofences.length > 0;

      if (hasGeofences) {
        // ✅ FORZA ENABLE SENZA INTERVAL
        const command = await storage.createDeviceCommand({
          deviceId: device.id,
          commandType: 'enable_geofence_monitoring',
          commandData: JSON.stringify({
            reason: 'manual_sync',
            geofenceCount: geofences.length,
          }),
          status: 'pending',
        });

        await storage.addSystemLog({
          deviceId: device.id,
          level: 'info',
          category: 'geofence',
          message: `Manual geofencing sync - enable command sent (Command: ${command.id})`,
          metadata: {
            commandId: command.id,
            geofenceCount: geofences.length,
          },
        });

        res.json({
          success: true,
          action: 'enabled',
          message: `Geofencing enabled for ${geofences.length} zones`,
          commandId: command.id,
          geofences: geofences.length,
        });
      } else {
        // ✅ FORZA DISABLE
        const command = await storage.createDeviceCommand({
          deviceId: device.id,
          commandType: 'disable_geofence_monitoring',
          commandData: JSON.stringify({
            reason: 'manual_sync_no_geofences',
          }),
          status: 'pending',
        });

        await storage.addSystemLog({
          deviceId: device.id,
          level: 'info',
          category: 'geofence',
          message: `Manual geofencing sync - disable command sent (Command: ${command.id})`,
          metadata: {
            commandId: command.id,
          },
        });

        res.json({
          success: true,
          action: 'disabled',
          message: 'Geofencing disabled - no active zones',
          commandId: command.id,
          geofences: 0,
        });
      }
    } catch (error) {
      console.error('Sync geofencing error:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);


// Lost Mode APIs
router.post("/api/devices/:deviceId/lost-mode", async (req: Request, res: Response) => {
  try {
    const { deviceId } = req.params;
    const { lostMode } = req.body;
    
    const device = await storage.getDeviceByDeviceId(deviceId);
    if (!device) {
      return res.status(404).json({ error: "Device not found" });
    }
    
    // Check for existing pending commands
    const pendingCommands = await storage.getPendingCommandsByDevice(device.id);
    const existingLostModeCommand = pendingCommands.find(cmd => 
      cmd.commandType === "enable_lost_mode" || cmd.commandType === "disable_lost_mode"
    );
    
    if (lostMode) {
      // Enabling lost mode
      if (existingLostModeCommand && existingLostModeCommand.commandType === "enable_lost_mode") {
        return res.status(400).json({ 
          error: "Lost mode command already pending",
          canCancel: true,
          commandId: existingLostModeCommand.id
        });
      }
      
      // Cancel any disable command if exists
      if (existingLostModeCommand && existingLostModeCommand.commandType === "disable_lost_mode") {
        await storage.updateCommandStatus(existingLostModeCommand.id, "cancelled");
      }
      
      // Create enable command
      const command = await storage.createDeviceCommand({
        deviceId: device.id,
        commandType: "enable_lost_mode",
        status: "pending",
      });
      
      await storage.addSystemLog({
        deviceId: device.id,
        level: "info",
        category: "command",
        message: `Lost mode enable command sent (ID: ${command.id})`,
      });
      
      res.json({ 
        success: true, 
        message: "Lost mode command sent to device",
        commandId: command.id,
        status: "pending"
      });
      
    } else {
      // Disabling lost mode
      if (existingLostModeCommand && existingLostModeCommand.commandType === "disable_lost_mode") {
        return res.status(400).json({ 
          error: "Lost mode disable command already pending",
          canCancel: true,
          commandId: existingLostModeCommand.id
        });
      }
      
      // Cancel any enable command if exists
      if (existingLostModeCommand && existingLostModeCommand.commandType === "enable_lost_mode") {
        await storage.updateCommandStatus(existingLostModeCommand.id, "cancelled");
      }
      
      // Create disable command
      const command = await storage.createDeviceCommand({
        deviceId: device.id,
        commandType: "disable_lost_mode", 
        status: "pending",
      });
      
      await storage.addSystemLog({
        deviceId: device.id,
        level: "info",
        category: "command",
        message: `Lost mode disable command sent (ID: ${command.id})`,
      });
      
      res.json({ 
        success: true, 
        message: "Lost mode disable command sent to device",
        commandId: command.id,
        status: "pending"
      });
    }
    
  } catch (error) {
    console.error("Lost mode error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Cancel command endpoint
router.delete("/api/devices/:deviceId/commands/:commandId", async (req: Request, res: Response) => {
  try {
    const { deviceId, commandId } = req.params;
    
    const device = await storage.getDeviceByDeviceId(deviceId);
    if (!device) {
      return res.status(404).json({ error: "Device not found" });
    }
    
    // Cancel the command
    const success = await storage.updateCommandStatus(commandId, "cancelled");
    
    if (!success) {
      return res.status(404).json({ error: "Command not found" });
    }
    
    await storage.addSystemLog({
      deviceId: device.id,
      level: "info",
      category: "command",
      message: `Command ${commandId} cancelled by user`,
    });
    
    res.json({ success: true, message: "Command cancelled" });
  } catch (error) {
    console.error("Cancel command error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Get device status with pending commands
router.get("/api/devices/:deviceId/status", async (req: Request, res: Response) => {
  try {
    const { deviceId } = req.params;
    
    const device = await storage.getDeviceByDeviceId(deviceId);
    if (!device) {
      return res.status(404).json({ error: "Device not found" });
    }
    
    // Get pending commands
    const pendingCommands = await storage.getPendingCommandsByDevice(device.id);
    const lostModeCommand = pendingCommands.find(cmd => 
      cmd.commandType === "enable_lost_mode" || cmd.commandType === "disable_lost_mode"
    );
    
    res.json({
      device,
      pendingCommands,
      lostModeCommand,
      hasLostModeCommand: !!lostModeCommand
    });
  } catch (error) {
    console.error("Get device status error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// System Logs APIs
router.get("/api/system-logs", async (req: Request, res: Response) => {
  try {
    const deviceIdParam = req.query.deviceId as string;
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;
    const date = req.query.date as string;
    
    let deviceUuid: string | undefined = undefined;
    if (deviceIdParam) {
      const device = await storage.getDeviceByDeviceId(deviceIdParam);
      deviceUuid = device?.id;
    }
    
    const [logs, totalCount] = await Promise.all([
      storage.getSystemLogs(deviceUuid, limit, date, offset),
      storage.getSystemLogsCount(deviceUuid, date)
    ]);
    
    res.json({
      logs,
      totalCount,
      hasMore: offset + limit < totalCount
    });
  } catch (error) {
    console.error("Get system logs error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Geofence Alerts APIs  
router.get("/api/devices/:deviceId/geofence-alerts", async (req: Request, res: Response) => {
  try {
    const { deviceId } = req.params;
    const device = await storage.getDeviceByDeviceId(deviceId);
    
    if (!device) {
      return res.status(404).json({ error: "Device not found" });
    }
    
    const limit = parseInt(req.query.limit as string) || 50;
    const alerts = await storage.getGeofenceAlertsByDevice(device.id, limit);
    
    res.json(alerts);
  } catch (error) {
    console.error("Get geofence alerts error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/api/devices/:deviceId/unread-alerts-count", async (req: Request, res: Response) => {
  try {
    const { deviceId } = req.params;
    const device = await storage.getDeviceByDeviceId(deviceId);
    
    if (!device) {
      return res.status(404).json({ error: "Device not found" });
    }
    
    const count = await storage.getUnreadAlertsCount(device.id);
    res.json({ count });
  } catch (error) {
    console.error("Get unread alerts count error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Helper functions
async function checkGeofencing(deviceId: string, latitude: number, longitude: number) {
  try {
    const geofences = await storage.getGeofencesByDevice(deviceId);
    
    for (const geofence of geofences) {
      if (!geofence.isActive) continue;
      
      const distance = calculateDistance(
        latitude,
        longitude,
        parseFloat(geofence.centerLatitude),
        parseFloat(geofence.centerLongitude)
      );
      
      const isInside = distance <= parseFloat(geofence.radius);
      
      // Simple geofence logic - in a real implementation you'd track previous state
      if (isInside && geofence.alertOnEnter) {
        await storage.createGeofenceAlert({
          deviceId,
          geofenceId: geofence.id,
          alertType: "enter",
          latitude: latitude.toString(),
          longitude: longitude.toString(),
        });
        
        await storage.addSystemLog({
          deviceId,
          level: "warning",
          category: "geofence",
          message: `Device entered geofence: ${geofence.name}`,
          metadata: { geofenceId: geofence.id, latitude, longitude },
        });
      }
    }
  } catch (error) {
    console.error("Geofencing check error:", error);
  }
}

async function enableGeofenceMonitoring(deviceUuid: string, deviceId: string) {
  try {
    // Crea comando per attivare GPS per monitoraggio geofence
    const command = await storage.createDeviceCommand({
      deviceId: deviceUuid,
      commandType: "enable_geofence_monitoring",
      commandData: { 
        interval: 30000, // GPS ogni 30 secondi per geofence monitoring
        reason: "geofence_created"
      },
      status: "pending"
    });

    await storage.addSystemLog({
      deviceId: deviceUuid,
      level: "info",
      category: "geofence",
      message: `Geofence monitoring enabled - GPS activation command sent`,
      metadata: { commandId: command.id, deviceId }
    });

    console.log(`Geofence monitoring enabled for device ${deviceId} - Command ${command.id} created`);
  } catch (error) {
    console.error("Error enabling geofence monitoring:", error);
  }
}

async function disableGeofenceMonitoring(deviceUuid: string, deviceId: string) {
  try {
    // Verifica se ci sono ancora geofence attive
    const activeGeofences = await storage.getGeofencesByDevice(deviceUuid);
    
    if (activeGeofences.length === 0) {
      // Nessuna geofence attiva, disattiva GPS
      const command = await storage.createDeviceCommand({
        deviceId: deviceUuid,
        commandType: "disable_geofence_monitoring",
        commandData: { 
          reason: "no_active_geofences"
        },
        status: "pending"
      });

      await storage.addSystemLog({
        deviceId: deviceUuid,
        level: "info", 
        category: "geofence",
        message: `Geofence monitoring disabled - no active geofences`,
        metadata: { commandId: command.id, deviceId }
      });

      console.log(`Geofence monitoring disabled for device ${deviceId} - Command ${command.id} created`);
    }
  } catch (error) {
    console.error("Error disabling geofence monitoring:", error);
  }
}

function calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000; // Earth's radius in meters
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

export async function registerRoutes(app: Express): Promise<Server> {
  // Setup authentication first
  await setupAuth(app);
  
  app.use(router);
  
  const server = new Server(app);
  return server;
}