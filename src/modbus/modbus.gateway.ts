import {
	WebSocketGateway,
	WebSocketServer,
	SubscribeMessage,
	OnGatewayConnection,
	OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger, Inject, forwardRef } from '@nestjs/common';
import { DeviceState, DevicesState } from './device.types';
import { ModbusService } from './modbus.service';

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

	constructor(
		@Inject(forwardRef(() => ModbusService))
		private readonly modbusService: ModbusService,
	) {}

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

	// Обработчик команды включения/выключения кондиционера
	@SubscribeMessage('command')
	async handleCommand(client: Socket, payload: { deviceId: string; command: string; value?: any }) {
		this.logger.log(`Получена команда: ${JSON.stringify(payload)}`);

		try {
			// Извлекаем ID устройства из строки "AC_5" -> 5
			const deviceId = parseInt(payload.deviceId.replace('AC_', ''));

			if (isNaN(deviceId)) {
				client.emit('commandError', { message: 'Неверный ID устройства' });
				return;
			}

			let success = false;

			switch (payload.command) {
				case 'POWER':
					// Включение/выключение: true -> режим 2, false -> режим 0
					success = await this.modbusService.setPowerState(deviceId, payload.value);
					break;

				case 'SET_TEMPERATURE':
					// Установка уставки температуры
					success = await this.modbusService.setTemperatureSetpoint(deviceId, payload.value);
					break;

				case 'SET_FAN_SPEED':
					// Установка скорости вентилятора
					success = await this.modbusService.setFanSpeed(deviceId, payload.value);
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
