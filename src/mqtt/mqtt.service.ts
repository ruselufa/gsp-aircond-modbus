import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { connect } from 'mqtt';
import { mqttConfigs } from './mqtt.config';

interface MqttHandler {
	topic: string;
	handler: (topic: string, message: string) => void;
}

@Injectable()
export class MqttService implements OnModuleInit, OnModuleDestroy {
	private client: any = null;
	private readonly logger = new Logger(MqttService.name);
	private readonly handlers: MqttHandler[] = [];
	private isConnected = false;
	private reconnectAttempts = 0;
	private readonly MAX_RECONNECT_ATTEMPTS = 5;
	private readonly RECONNECT_DELAY = 5000; // 5 секунд
	private reconnectTimeout: NodeJS.Timeout | null = null;

	onModuleInit() {
		this.connectToBroker();
	}

	onModuleDestroy() {
		if (this.reconnectTimeout) {
			clearTimeout(this.reconnectTimeout);
		}
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
			keepalive: 60,
			reconnectPeriod: 0, // Отключаем автоматический reconnect, используем свой
		});

		this.client.on('connect', () => {
			this.logger.log('Connected to MQTT broker');
			this.isConnected = true;
			this.reconnectAttempts = 0;
			
			// Переподписываемся на все топики после переподключения
			this.handlers.forEach(handler => {
				this.client.subscribe(handler.topic, (err: Error | null) => {
					if (err) {
						this.logger.error(`Failed to resubscribe to ${handler.topic}: ${err.message}`);
					} else {
						this.logger.debug(`Resubscribed to topic: ${handler.topic}`);
					}
				});
			});
		});

		this.client.on('error', (error: Error) => {
			this.logger.error(`MQTT error: ${error.message}`);
			this.isConnected = false;
		});

		this.client.on('close', () => {
			this.logger.warn('MQTT connection closed');
			this.isConnected = false;
			this.scheduleReconnect();
		});

		this.client.on('offline', () => {
			this.logger.warn('MQTT client went offline');
			this.isConnected = false;
		});

		// Централизованная обработка сообщений
		this.client.on('message', (msgTopic: string, message: Buffer) => {
			const messageStr = message.toString();
			this.logger.debug(`[MQTT] Получено сообщение: ${msgTopic} = ${messageStr}`);
			
			// Находим все обработчики для этого топика
			this.handlers.forEach(handler => {
				if (handler.topic === msgTopic) {
					try {
						handler.handler(msgTopic, messageStr);
					} catch (error) {
						this.logger.error(`Ошибка в обработчике для топика ${msgTopic}: ${error}`);
					}
				}
			});
		});
	}

	private scheduleReconnect() {
		if (this.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
			this.logger.error(`Превышено максимальное количество попыток переподключения (${this.MAX_RECONNECT_ATTEMPTS})`);
			return;
		}

		this.reconnectAttempts++;
		this.logger.log(`Планирование переподключения через ${this.RECONNECT_DELAY}ms (попытка ${this.reconnectAttempts}/${this.MAX_RECONNECT_ATTEMPTS})`);
		
		this.reconnectTimeout = setTimeout(() => {
			this.logger.log('Попытка переподключения к MQTT брокеру...');
			this.connectToBroker();
		}, this.RECONNECT_DELAY);
	}

	subscribe(topic: string, handler: (topic: string, message: string) => void) {
		if (!this.client || !this.isConnected) {
			this.logger.error('MQTT client not initialized or not connected');
			return;
		}

		// Проверяем, не подписаны ли уже на этот топик
		const existingHandler = this.handlers.find(h => h.topic === topic);
		if (existingHandler) {
			this.logger.warn(`Уже подписаны на топик: ${topic}`);
			return;
		}

		// Добавляем обработчик в список
		this.handlers.push({ topic, handler });
		this.logger.log(`📝 Добавлен обработчик для топика: ${topic} (всего обработчиков: ${this.handlers.length})`);

		this.client.subscribe(topic, (err: Error | null) => {
			if (err) {
				this.logger.error(`Failed to subscribe to ${topic}: ${err.message}`);
			} else {
				this.logger.log(`✅ Успешно подписались на топик: ${topic}`);
			}
		});
	}

	unsubscribe(topic: string) {
		if (!this.client || !this.isConnected) {
			return;
		}

		// Удаляем обработчик из списка
		const index = this.handlers.findIndex(h => h.topic === topic);
		if (index !== -1) {
			this.handlers.splice(index, 1);
		}

		this.client.unsubscribe(topic, (err: Error | null) => {
			if (err) {
				this.logger.error(`Failed to unsubscribe from ${topic}: ${err.message}`);
			} else {
				this.logger.log(`Unsubscribed from topic: ${topic}`);
			}
		});
	}

	publish(topic: string, message: string | number | boolean) {
		if (!this.client || !this.isConnected) {
			this.logger.error('MQTT client not initialized or not connected');
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

	getConnectionStatus(): boolean {
		return this.isConnected;
	}

	getConnectionInfo(): { isConnected: boolean; reconnectAttempts: number; handlersCount: number } {
		return {
			isConnected: this.isConnected,
			reconnectAttempts: this.reconnectAttempts,
			handlersCount: this.handlers.length,
		};
	}
}
