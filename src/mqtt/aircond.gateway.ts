import {
	WebSocketGateway,
	WebSocketServer,
	SubscribeMessage,
	OnGatewayConnection,
	OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';
import { DeviceState, DevicesState } from '../modbus/device.types';
import { AircondMqttService } from './aircond-mqtt.service';
import { setAircondGatewayInstance } from './aircond-mqtt.service';

@WebSocketGateway({
	cors: {
		origin: [
			'http://localhost:3000',
			'http://localhost:3001',
			'http://127.0.0.1:3000',
			'http://127.0.0.1:3001',
			'null',
		],
		methods: ['GET', 'POST'],
		credentials: true,
	},
	transports: ['websocket', 'polling'],
})
export class AircondGateway implements OnGatewayConnection, OnGatewayDisconnect {
	@WebSocketServer()
	server: Server;

	private readonly logger = new Logger(AircondGateway.name);
	private connectedClients = 0;

	constructor(private readonly aircondMqttService: AircondMqttService) {
		setAircondGatewayInstance(this);
	}

	handleConnection(client: Socket) {
		this.connectedClients++;
		this.logger.log(`Client connected. Total clients: ${this.connectedClients}`);

	// Сразу присоединяем и отправляем текущее известное состояние (ускорение первого показа)
	client.join('device-updates');
	try {
		const snapshot = this.aircondMqttService.getSnapshotDevices();
		if (snapshot && snapshot.length > 0) {
			const devicesState: DevicesState = {
				devices: snapshot,
				clientCount: this.connectedClients,
			};
			client.emit('devicesState', devicesState);
		}
	} catch (e) {
		this.logger.warn(`Не удалось отправить мгновенный снимок состояния: ${e}`);
	}
	}

	handleDisconnect(client: Socket) {
		this.connectedClients--;
		this.logger.log(`Client disconnected. Total clients: ${this.connectedClients}`);
	}

	@SubscribeMessage('subscribe')
	handleSubscribe(client: Socket) {
		this.logger.log('Client subscribed to device updates');
		client.join('device-updates');
	}

	@SubscribeMessage('unsubscribe')
	handleUnsubscribe(client: Socket) {
		this.logger.log('Client unsubscribed from device updates');
		client.leave('device-updates');
	}

	@SubscribeMessage('command')
	async handleCommand(client: Socket, payload: { deviceId: string; command: string; value?: any }) {
		this.logger.log(`Получена команда: ${JSON.stringify(payload)}`);
		try {
			const deviceId = parseInt(payload.deviceId.replace('AC_', ''));
			if (isNaN(deviceId)) {
				client.emit('commandError', { message: 'Неверный ID устройства' });
				return;
			}
			let success = false;
			switch (payload.command) {
				case 'POWER':
					success = await this.aircondMqttService.setPowerState(deviceId, payload.value);
					break;
				case 'SET_TEMPERATURE':
					success = await this.aircondMqttService.setTemperatureSetpoint(deviceId, payload.value);
					break;
				case 'SET_FAN_SPEED':
					success = await this.aircondMqttService.setFanSpeed(deviceId, payload.value);
					break;
				default:
					client.emit('commandError', { message: `Неизвестная команда: ${payload.command}` });
					return;
			}
			if (success) {
				client.emit('commandSuccess', {
					deviceId: payload.deviceId,
					command: payload.command,
					value: payload.value,
				});
				this.logger.log(
					`Команда выполнена успешно: ${payload.command} для устройства ${payload.deviceId}`,
				);
			} else {
				client.emit('commandError', {
					message: `Ошибка выполнения команды: ${payload.command}`,
				});
			}
		} catch (error) {
			this.logger.error(`Ошибка обработки команды: ${error}`);
			client.emit('commandError', { message: 'Внутренняя ошибка сервера' });
		}
	}

	broadcastDevicesState(devices: DeviceState[]) {
		const devicesState: DevicesState = {
			devices,
			clientCount: this.connectedClients,
		};
		
		this.logger.log(`[WEBSOCKET] Отправка состояния ${devices.length} устройств к ${this.connectedClients} клиентам`);
		
		this.server.to('device-updates').emit('devicesState', devicesState);
		
		// Логируем детали для отладки
		devices.forEach(device => {
			this.logger.debug(`[DEVICE] ${device.id}: temp=${device.temperature}°C, setpoint=${device.setTemperature}°C, power=${device.isOn ? 'ON' : 'OFF'}`);
		});
	}
}
