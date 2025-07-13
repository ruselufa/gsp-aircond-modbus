import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { connect } from 'mqtt';
import { mqttConfigs } from './mqtt.config';

@Injectable()
export class MqttService implements OnModuleInit, OnModuleDestroy {
	private client: any = null; // временно any для устранения ошибок unsafe member access
	private readonly logger = new Logger(MqttService.name);

	onModuleInit() {
		this.connectToBroker();
	}

	onModuleDestroy() {
		if (this.client) {
			this.client.end();
			this.logger.log('Disconnected from MQTT broker');
		}
	}

	private connectToBroker() {
		const config = mqttConfigs.aircond;
		this.logger.log(`Connecting to MQTT broker at ${config.host}:${config.port}`);
		this.client = connect({
			host: config.host,
			port: config.port,
			protocol: config.protocol,
			clientId: config.clientId,
			username: config.username,
			password: config.password,
		});

		this.client.on('connect', () => {
			this.logger.log('Connected to MQTT broker');
		});

		this.client.on('error', (error: Error) => {
			this.logger.error(`MQTT error: ${error.message}`);
		});

		this.client.on('close', () => {
			this.logger.warn('MQTT connection closed');
		});
	}

	subscribe(topic: string, handler: (topic: string, message: string) => void) {
		if (!this.client) {
			this.logger.error('MQTT client not initialized');
			return;
		}
		this.client.subscribe(topic, (err: Error | null) => {
			if (err) {
				this.logger.error(`Failed to subscribe to ${topic}: ${err.message}`);
			} else {
				this.logger.log(`Subscribed to topic: ${topic}`);
			}
		});
		this.client.on('message', (msgTopic: string, message: Buffer) => {
			if (msgTopic === topic) {
				handler(msgTopic, message.toString());
			}
		});
	}

	publish(topic: string, message: string | number | boolean) {
		if (!this.client) {
			this.logger.error('MQTT client not initialized');
			return;
		}
		this.client.publish(topic, String(message), {}, (err?: Error) => {
			if (err) {
				this.logger.error(`Ошибка публикации в ${topic}: ${err.message}`);
			} else {
				this.logger.log(`Опубликовано в ${topic}: ${message}`);
			}
		});
	}
}
