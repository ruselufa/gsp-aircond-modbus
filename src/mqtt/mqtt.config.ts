export interface MqttConfig {
	host: string;
	port: number;
	username?: string;
	password?: string;
	clientId: string;
	protocol: 'mqtt' | 'mqtts';
}

export const mqttConfigs: Record<string, MqttConfig> = {
	aircond: {
		host: process.env.MQTT_HOST_AIRCOND || '192.168.1.12',
		port: parseInt(process.env.MQTT_PORT_AIRCOND || '1883'),
		clientId: 'aircond_modbus_client',
		protocol: 'mqtt',
	},
};
