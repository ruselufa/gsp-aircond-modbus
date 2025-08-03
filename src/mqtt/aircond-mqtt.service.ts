import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { MqttService } from './mqtt.service';
import { DeviceState } from '../modbus/device.types';

let aircondGatewayInstance: any = null;
export function setAircondGatewayInstance(gateway: any) {
	aircondGatewayInstance = gateway;
}

interface AircondConfig {
	broker: string;
	id: number;
}

// Список ID кондиционеров (пример: 55, 56, 57)
const AC_IDS: Record<number, AircondConfig> = {
	5: { broker: 'wb-modbus-8-0', id: 5 },
	6: { broker: 'wb-modbus-8-1', id: 6 },
	7: { broker: 'wb-modbus-8-2', id: 7 },
};

// Маппинг топиков для каждого кондиционера
const TOPIC_MAP = (cfg: { broker: string; id: number }) => ({
	mode: `/devices/${cfg.broker}/controls/5${cfg.id}_Режим_R`,
	setpoint: `/devices/${cfg.broker}/controls/5${cfg.id}_Уставка_R`,
	fanSpeed: `/devices/${cfg.broker}/controls/5${cfg.id}_Скорость_R`,
	temperature: `/devices/${cfg.broker}/controls/5${cfg.id}_PV`,
	waterTemperature: `/devices/${cfg.broker}/controls/5${cfg.id}_CoolingWater`,
	pumpStatus: `/devices/${cfg.broker}/controls/5${cfg.id}_Pump_State`,
	valveStatus: `/devices/${cfg.broker}/controls/5${cfg.id}_FC_Dial_Info_2_1619`,
});

const CMD_TOPIC_MAP = (cfg: { broker: string; id: number }) => ({
	mode: `/devices/${cfg.broker}/controls/5${cfg.id}_Режим_W`,
	setpoint: `/devices/${cfg.broker}/controls/5${cfg.id}_Уставка_W`,
	fanSpeed: `/devices/${cfg.broker}/controls/5${cfg.id}_Скорость_W`,
});

@Injectable()
export class AircondMqttService implements OnModuleInit {
	private readonly logger = new Logger(AircondMqttService.name);
	private states: Record<number, Partial<DeviceState>> = {};
	private rawMqtt: Record<number, Record<string, string>> = {};
	private updateTimeout: NodeJS.Timeout | null = null;
	private readonly UPDATE_DELAY = 1000; // 1 секунда между обновлениями
	private pendingUpdates = new Set<number>();
	private isInitialized = false;

	constructor(private readonly mqttService: MqttService) {}

	async onModuleInit() {
		this.logger.log('🚀 Инициализация AircondMqttService...');
		
		// Инициализируем состояния устройств
		for (const id of [5, 6, 7]) {
			const cfg: AircondConfig = AC_IDS[id];
			if (!cfg) {
				this.logger.error(`❌ Неизвестный ID кондиционера: ${id}`);
				throw new Error(`Unknown AC id: ${id}`);
			}
			
			this.states[id] = { id: `AC_${id}`, name: `Кондиционер ${id}` };
			this.rawMqtt[id] = {};
		}
		
		// Ждем подключения MQTT и подписываемся на топики
		await this.waitForMqttConnection();
		await this.subscribeToTopics();
		
		this.isInitialized = true;
		this.logger.log('🎉 AircondMqttService успешно инициализирован');
		this.logger.log(`📊 Всего устройств: ${Object.keys(this.states).length}`);
	}

	private async waitForMqttConnection(): Promise<void> {
		this.logger.log('⏳ Ожидание подключения к MQTT брокеру...');
		
		return new Promise((resolve) => {
			const checkConnection = () => {
				if (this.mqttService.getConnectionStatus()) {
					this.logger.log('✅ MQTT подключение установлено');
					resolve();
				} else {
					this.logger.log('⏳ MQTT еще не подключен, ждем...');
					setTimeout(checkConnection, 1000);
				}
			};
			checkConnection();
		});
	}

	private async subscribeToTopics(): Promise<void> {
		this.logger.log('📡 Подписка на MQTT топики...');
		
		for (const id of [5, 6, 7]) {
			const cfg: AircondConfig = AC_IDS[id];
			this.logger.log(`📡 Настройка кондиционера AC_${id} с брокером ${cfg.broker}`);
			const topics = TOPIC_MAP(cfg);
			
			Object.entries(topics).forEach(([key, topic]) => {
				this.logger.log(`🔔 Подписка на топик: ${topic} (${key})`);
				this.mqttService.subscribe(topic, (msgTopic, message) => {
					this.logger.log(`📨 Получено MQTT сообщение для AC_${id}: ${key} = ${message}`);
					this.handleMqttMessage(id, key, message);
				});
			});
			
			this.logger.log(`✅ Кондиционер AC_${id} инициализирован`);
		}
	}

	private handleMqttMessage(id: number, key: string, value: string) {
		this.logger.log(`[MQTT] AC_${id} | ${key}: ${value}`);
		const state = this.states[id] || { id: `AC_${id}`, name: `Кондиционер ${id}` };
		let num: number | undefined = undefined;
		if (key === 'valveStatus') num = Number(value);
		
		// Парсим значения по ключу
		switch (key) {
			case 'mode':
				state.mode = this.parseMode(Number(value));
				state.isOn = Number(value) > 0;
				break;
			case 'setpoint':
				state.setTemperature = Number(value);
				break;
			case 'fanSpeed':
				state.fanSpeed = Number(value);
				break;
			case 'temperature':
				state.temperature = Number(value);
				break;
			case 'waterTemperature':
				state.waterTemperature = Number(value);
				break;
			case 'pumpStatus':
				state.pumpStatus = value === '1';
				break;
			case 'valveStatus':
				if (num !== undefined) state.valveStatus = (num & (1 << 9)) !== 0;
				break;
		}
		state.isOnline = true;
		
		// Сохраняем сырое значение
		if (!this.rawMqtt[id]) this.rawMqtt[id] = {};
		this.rawMqtt[id][key] = value;
		
		this.states[id] = state;
		
		// Добавляем в список ожидающих обновлений
		this.pendingUpdates.add(id);
		
		// Запускаем throttled обновление
		this.scheduleUpdate();
	}

	private scheduleUpdate() {
		// Если уже есть запланированное обновление, отменяем его
		if (this.updateTimeout) {
			clearTimeout(this.updateTimeout);
		}

		// Планируем новое обновление через задержку
		this.updateTimeout = setTimeout(() => {
			this.pushToFrontend();
			this.pendingUpdates.clear();
			this.updateTimeout = null;
		}, this.UPDATE_DELAY);
	}

	private parseMode(val: number): string {
		if (val === 0) return 'Выключен';
		if (val === 2) return 'Охлаждение';
		return 'Неизвестно';
	}

	private pushToFrontend() {
		if (!this.isInitialized) {
			this.logger.warn('⚠️ Попытка отправить данные до инициализации сервиса');
			return;
		}
		
		const devices: DeviceState[] = Object.values(this.states).map((s) => ({
			id: s.id!,
			name: s.name!,
			isOnline: s.isOnline ?? false,
			mode: s.mode ?? '',
			isOn: s.isOn ?? false,
			setTemperature: s.setTemperature ?? 0,
			fanSpeed: s.fanSpeed ?? 0,
			temperature: s.temperature ?? 0,
			waterTemperature: s.waterTemperature ?? 0,
			pumpStatus: s.pumpStatus ?? false,
			valveStatus: s.valveStatus ?? false,
			errors: {
				tempSensorError: false,
				waterTempSensor1Error: false,
				waterTempSensor2Error: false,
				fanSpeedError: false,
				pumpError: false,
			},
			protectionState: 0,
			rawMqtt: this.rawMqtt[Number(s.id?.replace('AC_', ''))] || {},
		}));
		
		if (aircondGatewayInstance) {
			this.logger.log(`[WEBSOCKET] Отправка обновлений для ${devices.length} устройств`);
			aircondGatewayInstance.broadcastDevicesState(devices);
		} else {
			this.logger.warn('⚠️ AircondGateway не инициализирован');
		}
	}

	// Метод для принудительного обновления (для команд управления)
	public forceUpdate() {
		if (this.updateTimeout) {
			clearTimeout(this.updateTimeout);
			this.updateTimeout = null;
		}
		this.pushToFrontend();
		this.pendingUpdates.clear();
	}

	async setPowerState(id: number, isOn: boolean): Promise<boolean> {
		const cfg = AC_IDS[id];
		const topic = CMD_TOPIC_MAP(cfg).mode;
		const value = isOn ? 2 : 0;
		const success = await this.publishCommand(`${topic}/on`, value);
		if (success) {
			// Принудительное обновление после команды управления
			setTimeout(() => this.forceUpdate(), 500);
		}
		return success;
	}

	async setTemperatureSetpoint(id: number, temperature: number): Promise<boolean> {
		const cfg = AC_IDS[id];
		const topic = CMD_TOPIC_MAP(cfg).setpoint;
		const success = await this.publishCommand(`${topic}/on`, temperature);
		if (success) {
			// Принудительное обновление после команды управления
			setTimeout(() => this.forceUpdate(), 500);
		}
		return success;
	}

	async setFanSpeed(id: number, speed: number): Promise<boolean> {
		const cfg = AC_IDS[id];
		const topic = CMD_TOPIC_MAP(cfg).fanSpeed;
		const success = await this.publishCommand(`${topic}/on`, speed);
		if (success) {
			// Принудительное обновление после команды управления
			setTimeout(() => this.forceUpdate(), 500);
		}
		return success;
	}

	private publishCommand(topic: string, value: number): Promise<boolean> {
		return new Promise((resolve) => {
			try {
				this.mqttService.publish(topic, value);
				this.logger.log(`MQTT команда: ${topic} = ${value}`);
				resolve(true);
			} catch (e) {
				this.logger.error(`Ошибка публикации MQTT команды: ${e}`);
				resolve(false);
			}
		});
	}
}
