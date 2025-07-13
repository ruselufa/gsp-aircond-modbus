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

	constructor(private readonly mqttService: MqttService) {}

	onModuleInit() {
		for (const id of [5, 6, 7]) {
			const cfg: AircondConfig = AC_IDS[id];
			if (!cfg) throw new Error(`Unknown AC id: ${id}`);
			const topics = TOPIC_MAP(cfg);
			Object.entries(topics).forEach(([key, topic]) => {
				this.mqttService.subscribe(topic, (msgTopic, message) => {
					this.handleMqttMessage(id, key, message);
				});
			});
			// Инициализируем состояние
			this.states[id] = { id: `AC_${id}`, name: `Кондиционер ${id}` };
			this.rawMqtt[id] = {};
		}
		this.logger.log('AircondMqttService подписан на все топики кондиционеров');
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
		// TODO: обработка ошибок и protectionState при необходимости
		this.states[id] = state;
		this.pushToFrontend();
	}

	private parseMode(val: number): string {
		if (val === 0) return 'Выключен';
		if (val === 2) return 'Охлаждение';
		return 'Неизвестно';
	}

	private pushToFrontend() {
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
			aircondGatewayInstance.broadcastDevicesState(devices);
		}
	}

	async setPowerState(id: number, isOn: boolean): Promise<boolean> {
		const cfg = AC_IDS[id];
		const topic = CMD_TOPIC_MAP(cfg).mode;
		const value = isOn ? 2 : 0;
		return this.publishCommand(`${topic}/on`, value);
	}

	async setTemperatureSetpoint(id: number, temperature: number): Promise<boolean> {
		const cfg = AC_IDS[id];
		const topic = CMD_TOPIC_MAP(cfg).setpoint;
		return this.publishCommand(`${topic}/on`, temperature);
	}

	async setFanSpeed(id: number, speed: number): Promise<boolean> {
		const cfg = AC_IDS[id];
		const topic = CMD_TOPIC_MAP(cfg).fanSpeed;
		return this.publishCommand(`${topic}/on`, speed);
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
