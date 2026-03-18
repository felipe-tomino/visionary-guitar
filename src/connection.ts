import { webrtc, connectors } from '@roboflow/inference-sdk';
import { ROBOFLOW_WORKSPACE, ROBOFLOW_WORKFLOW_ID, API_PROXY_URL } from './constants';

export type RoboflowConnection = Awaited<ReturnType<typeof webrtc.useStream>>;

export async function connectToRoboflow(
  stream: MediaStream,
  onData: (data: unknown) => void
): Promise<RoboflowConnection> {
  const connector = connectors.withProxyUrl(API_PROXY_URL);

  return webrtc.useStream({
    source: stream,
    connector,
    wrtcParams: {
      workspaceName: ROBOFLOW_WORKSPACE,
      workflowId: ROBOFLOW_WORKFLOW_ID,
      imageInputName: 'image',
      dataOutputNames: ['predictions'],
    },
    onData,
  });
}
