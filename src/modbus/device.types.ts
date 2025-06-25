export interface DeviceState {
	id: string;
	name: string;
	isOnline: boolean;
	mode: string;
	isOn: boolean;
	setTemperature: number;
	fanSpeed: number;
	temperature: number;
	waterTemperature: number;
	pumpStatus: boolean;
	valveStatus: boolean;
	errors: {
		tempSensorError: boolean;
		waterTempSensor1Error: boolean;
		waterTempSensor2Error: boolean;
		fanSpeedError: boolean;
		pumpError: boolean;
	};
	protectionState: number;
}

export interface DevicesState {
	devices: DeviceState[];
	clientCount: number;
}
