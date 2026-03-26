import { webrtc, connectors } from '@roboflow/inference-sdk';
import { API_PROXY_URL } from './constants';
import workflowSpec from '../workflow/workflow.json';

export type RoboflowConnection = Awaited<ReturnType<typeof webrtc.useStream>>;

export async function connectToRoboflow(
  stream: MediaStream,
  onData: (data: unknown) => void,
): Promise<RoboflowConnection> {
  const connector = connectors.withProxyUrl(API_PROXY_URL);

  return webrtc.useStream({
    source: stream,
    connector,
    wrtcParams: {
      workflowSpec,
      imageInputName: 'image',
      streamOutputNames: [],
      dataOutputNames: ['predictions'],
      threadPoolWorkers: 1,
    },
    onData,
  });
}
