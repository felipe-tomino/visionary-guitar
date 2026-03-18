import { streams } from '@roboflow/inference-sdk';

const VIDEO_CONSTRAINTS = {
  width: { ideal: 1280 },
  height: { ideal: 720 },
  frameRate: { ideal: 30 },
};

export async function getAvailableCameras(): Promise<MediaDeviceInfo[]> {
  // Request camera permission first to get device labels
  const tempStream = await navigator.mediaDevices.getUserMedia({ video: true });
  tempStream.getTracks().forEach(track => track.stop());

  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter(device => device.kind === 'videoinput');
}

export async function startCameraStream(deviceId: string): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    video: { deviceId: { exact: deviceId }, ...VIDEO_CONSTRAINTS },
    audio: false,
  });
}

export function stopStream(stream: MediaStream): void {
  streams.stopStream(stream);
}
