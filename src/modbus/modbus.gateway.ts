import {
	WebSocketGateway,
	WebSocketServer,
	SubscribeMessage,
	OnGatewayConnection,
	OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';
import { DeviceState, DevicesState } from './device.types';

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
export class ModbusGateway implements OnGatewayConnection, OnGatewayDisconnect {
	@WebSocketServer()
	server: Server;

	private readonly logger = new Logger(ModbusGateway.name);
	private connectedClients = 0;

	handleConnection(client: Socket) {
		this.connectedClients++;
		this.logger.log(`Client connected. Total clients: ${this.connectedClients}`);
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

	// Метод для отправки обновлений состояния всех устройств
	broadcastDevicesState(devices: DeviceState[]) {
		const devicesState: DevicesState = {
			devices,
			clientCount: this.connectedClients,
		};
		this.server.to('device-updates').emit('devicesState', devicesState);
		this.logger.log(`Devices state broadcasted to ${this.connectedClients} clients`);
	}

	// Метод для отправки обновлений состояния одного устройства (для обратной совместимости)
	broadcastDeviceState(state: DeviceState) {
		this.server.to('device-updates').emit('deviceState', {
			...state,
			clientCount: this.connectedClients,
		});
		this.logger.log(`Device state broadcasted to ${this.connectedClients} clients`);
	}

	// Метод для отправки ошибок
	broadcastError(error: string) {
		this.server.to('device-updates').emit('error', { message: error });
		this.logger.error(`Error broadcasted: ${error}`);
	}
}
