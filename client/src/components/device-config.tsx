import React, { useState, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { useToast } from '@/hooks/use-toast';
import { apiRequest } from '@/lib/queryClient';
import {
  Clock,
  Send,
  Battery,
  AlertTriangle,
  ArrowLeft,
  Wifi,
  MapPin,
} from 'lucide-react';

// ===== SCHEMA AGGIORNATO - 4 CONFIGURAZIONI ESSENZIALI SPECIFICATE =====
const deviceConfigSchema = z.object({
  heartbeatInterval: z.number().min(30).max(3600).default(300), // Quanto spesso "telefona a casa" + riceve comandi
  lostModeInterval: z.number().min(5).max(60).default(15), // Quanto spesso GPS quando smarrito
  geofenceGpsInterval: z.number().min(5).max(300).default(30), // Quanto spesso GPS per geofencing
  lowBatteryThreshold: z.number().min(5).max(50).default(15), // Soglia batteria bassa
});

type DeviceConfigForm = z.infer<typeof deviceConfigSchema>;

interface DeviceConfigProps {
  deviceId: string;
}

export default function DeviceConfig({ deviceId }: DeviceConfigProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // ===== FORM SETUP SENZA DEFAULT VALUES STATICI =====
  const form = useForm<DeviceConfigForm>({
    resolver: zodResolver(deviceConfigSchema),
    // ❌ RIMUOVO defaultValues statici - verranno caricati dal database
  });

  // ===== LOAD CURRENT CONFIG DAL DATABASE =====
  const { data: currentConfig, isLoading } = useQuery({
    queryKey: [`/api/devices/${deviceId}/config`],
    select: (data: any) => {
      console.log('📄 Config ricevuta dal database:', data.config);

      const configFromDb = {
        heartbeatInterval: Math.round(
          (data.config?.heartbeatInterval || 30000) / 1000
        ),
        lostModeInterval: Math.round(
          (data.config?.lostModeInterval || 15000) / 1000
        ),
        geofenceGpsInterval: Math.round(
          (data.config?.gpsReadInterval || 30000) / 1000
        ),
        lowBatteryThreshold: data.config?.lowBatteryThreshold || 15,
      };

      console.log('✅ Config processata per il form:', configFromDb);
      return configFromDb;
    },
  });

  // ===== UPDATE FORM WHEN CONFIG LOADS DAL DATABASE =====
  useEffect(() => {
    if (currentConfig) {
      console.log(
        '🔄 Aggiornamento form con config dal database:',
        currentConfig
      );

      // ✅ RESET del form con i valori caricati dal database
      form.reset({
        heartbeatInterval: currentConfig.heartbeatInterval,
        lostModeInterval: currentConfig.lostModeInterval,
        geofenceGpsInterval: currentConfig.geofenceGpsInterval,
        lowBatteryThreshold: currentConfig.lowBatteryThreshold,
      });

      console.log('✅ Form aggiornato con valori dal DB');
    }
  }, [currentConfig, form]);

  // ===== SEND CONFIG MUTATION =====
  const sendConfigMutation = useMutation({
    mutationFn: async (data: DeviceConfigForm) => {
      const devicePayload = {
        heartbeatInterval: data.heartbeatInterval * 1000,
        lostModeInterval: data.lostModeInterval * 1000,
        gpsReadInterval: data.geofenceGpsInterval * 1000, // Mapping per compatibilità con device
        lowBatteryThreshold: data.lowBatteryThreshold,
      };

      console.log('📤 Invio configurazione come comando:', devicePayload);

      return apiRequest('POST', `/api/devices/${deviceId}/commands`, {
        commandType: 'update_config',
        payload: devicePayload,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: [`/api/devices/${deviceId}/config`],
      });
      queryClient.invalidateQueries({
        queryKey: [`/api/devices/${deviceId}/commands`],
      });
      toast({
        title: '✅ Comando inviato',
        description:
          'Le nuove configurazioni saranno applicate al prossimo heartbeat',
      });
    },
    onError: (error: any) => {
      console.error('❌ Errore invio configurazione:', error);
      toast({
        title: '❌ Errore',
        description: 'Impossibile inviare la configurazione',
        variant: 'destructive',
      });
    },
  });

  const onSubmit = (data: DeviceConfigForm) => {
    sendConfigMutation.mutate(data);
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto mb-4"></div>
          <p className="text-gray-600">
            Caricamento configurazione dal database...
          </p>
        </div>
      </div>
    );
  }

  // ⚠️ IMPORTANTE: Non mostrare il form finché non abbiamo caricato la config dal DB
  if (!currentConfig) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="text-center">
          <div className="text-yellow-600 mb-4">⚠️</div>
          <p className="text-gray-600">
            Impossibile caricare la configurazione del dispositivo
          </p>
          <p className="text-sm text-gray-500 mt-2">ID: {deviceId}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-6 max-w-2xl">
      {/* === HEADER === */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold mb-2">⚙️ Configurazione Device</h1>
        <p className="text-gray-600 text-sm">
          Gestisci i parametri operativi del tracker GPS
        </p>
      </div>

      {/* === INFO CARD === */}
      <Card className="mb-6 bg-blue-50 border-blue-200">
        <CardContent className="pt-6">
          <div className="flex items-start gap-3">
            <AlertTriangle className="h-5 w-5 text-blue-600 mt-0.5 flex-shrink-0" />
            <div>
              <h3 className="font-semibold text-blue-900 mb-2">
                📡 Configurazioni Essenziali
              </h3>
              <p className="text-blue-800 text-sm leading-relaxed">
                Queste sono le 4 configurazioni principali del dispositivo. Le
                modifiche saranno inviate come comando e applicate al prossimo
                heartbeat. Le zone geografiche (geofencing) si gestiscono nella
                dashboard principale.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* === CONFIGURATION FORM === */}
      <Form {...form}>
        <form
          onSubmit={form.handleSubmit(onSubmit)}
          className="space-y-4 sm:space-y-6"
        >
          {/* === COMMUNICATION SETTINGS === */}
          <Card>
            <CardHeader className="pb-4">
              <CardTitle className="flex items-center gap-2 text-lg">
                <Clock className="h-5 w-5 text-blue-600" />
                Comunicazione
              </CardTitle>
              <CardDescription className="text-sm">
                Frequenza di comunicazione con il server
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 sm:space-y-6">
              <FormField
                control={form.control}
                name="heartbeatInterval"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-sm font-medium">
                      💓 Heartbeat (secondi)
                    </FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        {...field}
                        onChange={(e) =>
                          field.onChange(parseInt(e.target.value))
                        }
                        min="30"
                        max="3600"
                        className="text-base"
                      />
                    </FormControl>
                    <FormDescription className="text-xs">
                      Quanto spesso il dispositivo "telefona a casa" e riceve
                      comandi (30-3600s, default: 300 = 5min)
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </CardContent>
          </Card>

          {/* === GPS SETTINGS === */}
          <Card>
            <CardHeader className="pb-4">
              <CardTitle className="flex items-center gap-2 text-lg">
                <MapPin className="h-5 w-5 text-green-600" />
                GPS e Geolocalizzazione
              </CardTitle>
              <CardDescription className="text-sm">
                Configurazioni per tracking e modalità smarrimento
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 sm:space-y-6">
              <FormField
                control={form.control}
                name="lostModeInterval"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-sm font-medium">
                      🚨 GPS Lost Mode (secondi)
                    </FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        {...field}
                        onChange={(e) =>
                          field.onChange(parseInt(e.target.value))
                        }
                        min="5"
                        max="60"
                        className="text-base"
                      />
                    </FormControl>
                    <FormDescription className="text-xs">
                      Quanto spesso invia GPS quando il dispositivo è smarrito
                      (5-60s, default: 15s)
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="geofenceGpsInterval"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-sm font-medium">
                      🌍 GPS Geofencing (secondi)
                    </FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        {...field}
                        onChange={(e) =>
                          field.onChange(parseInt(e.target.value))
                        }
                        min="5"
                        max="300"
                        className="text-base"
                      />
                    </FormControl>
                    <FormDescription className="text-xs">
                      Quanto spesso controlla GPS per monitoraggio zone
                      geografiche (5-300s, default: 30s)
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </CardContent>
          </Card>

          {/* === POWER SETTINGS === */}
          <Card>
            <CardHeader className="pb-4">
              <CardTitle className="flex items-center gap-2 text-lg">
                <Battery className="h-5 w-5 text-orange-600" />
                Gestione Batteria
              </CardTitle>
              <CardDescription className="text-sm">
                Soglie di allarme per il livello batteria
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 sm:space-y-6">
              <FormField
                control={form.control}
                name="lowBatteryThreshold"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-sm font-medium">
                      🔋 Soglia Batteria Bassa (%)
                    </FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        {...field}
                        onChange={(e) =>
                          field.onChange(parseInt(e.target.value))
                        }
                        min="5"
                        max="50"
                        className="text-base"
                      />
                    </FormControl>
                    <FormDescription className="text-xs">
                      Soglia sotto la quale scatta l'allarme batteria bassa
                      (5-50%, default: 15%)
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </CardContent>
          </Card>

          {/* === SUBMIT BUTTON === */}
          <Card>
            <CardContent className="pt-6">
              <Button
                type="submit"
                className="w-full"
                disabled={sendConfigMutation.isPending}
              >
                <Send className="h-4 w-4 mr-2" />
                {sendConfigMutation.isPending
                  ? 'Invio comando...'
                  : 'Invia Configurazione'}
              </Button>

              <div className="flex items-center justify-center mb-4">
                <Badge variant="outline" className="text-xs">
                  <Wifi className="h-3 w-3 mr-1" />
                  Comando "update_config" via heartbeat
                </Badge>
              </div>

              <Separator className="my-4" />

              {/* === VALUES PREVIEW === */}
              <div className="grid grid-cols-2 gap-3 text-xs">
                <div className="text-center p-3 bg-gray-50 rounded-lg">
                  <div className="font-bold text-base text-gray-900 mb-1">
                    {form.watch('heartbeatInterval')}s
                  </div>
                  <div className="text-gray-600">💓 Heartbeat</div>
                </div>
                <div className="text-center p-3 bg-gray-50 rounded-lg">
                  <div className="font-bold text-base text-gray-900 mb-1">
                    {form.watch('lostModeInterval')}s
                  </div>
                  <div className="text-gray-600">🚨 GPS Lost</div>
                </div>
                <div className="text-center p-3 bg-gray-50 rounded-lg">
                  <div className="font-bold text-base text-gray-900 mb-1">
                    {form.watch('geofenceGpsInterval')}s
                  </div>
                  <div className="text-gray-600">🌍 Geofence GPS</div>
                </div>
                <div className="text-center p-3 bg-gray-50 rounded-lg">
                  <div className="font-bold text-base text-gray-900 mb-1">
                    {form.watch('lowBatteryThreshold')}%
                  </div>
                  <div className="text-gray-600">🔋 Batteria</div>
                </div>
              </div>
            </CardContent>
          </Card>
        </form>
      </Form>

      {/* Bottom padding for mobile */}
      <div className="h-8"></div>
    </div>
  );
}
