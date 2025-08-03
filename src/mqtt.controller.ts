import { Controller, Get, Logger } from '@nestjs/common';
import { MqttService } from './mqtt/mqtt.service';
import { AircondMqttService } from './mqtt/aircond-mqtt.service';

@Controller('mqtt')
export class MqttController {
	private readonly logger = new Logger(MqttController.name);

	constructor(
		private readonly mqttService: MqttService,
		private readonly aircondMqttService: AircondMqttService,
	) {}

	@Get('status')
	getMqttStatus() {
		const connectionInfo = this.mqttService.getConnectionInfo();
		return {
			...connectionInfo,
			timestamp: new Date().toISOString(),
			status: connectionInfo.isConnected ? 'connected' : 'disconnected',
		};
	}

	@Get('health')
	getHealth() {
		const connectionInfo = this.mqttService.getConnectionInfo();
		return {
			status: connectionInfo.isConnected ? 'healthy' : 'unhealthy',
			mqtt: {
				connected: connectionInfo.isConnected,
				reconnectAttempts: connectionInfo.reconnectAttempts,
				handlersCount: connectionInfo.handlersCount,
			},
			timestamp: new Date().toISOString(),
		};
	}
} 