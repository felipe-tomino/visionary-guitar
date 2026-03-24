import { webrtc, connectors } from '@roboflow/inference-sdk';
import { ROBOFLOW_WORKSPACE, ROBOFLOW_WORKFLOW_ID, API_PROXY_URL } from './constants';

export type RoboflowConnection = Awaited<ReturnType<typeof webrtc.useStream>>;

export interface WorkflowParams {
  scale_name: string;
  root_note: number;
  tuning: string;
  fret_count: number;
}

export async function connectToRoboflow(
  stream: MediaStream,
  onData: (data: unknown) => void,
  workflowParams?: WorkflowParams
): Promise<RoboflowConnection> {
  const connector = connectors.withProxyUrl(API_PROXY_URL);

  return webrtc.useStream({
    source: stream,
    connector,
    wrtcParams: {
      workspaceName: ROBOFLOW_WORKSPACE,
      workflowId: ROBOFLOW_WORKFLOW_ID,
      imageInputName: 'image',
      streamOutputNames: ['annotated_image'],
      dataOutputNames: [],
      workflowsParameters: workflowParams ? {
        scale_name: workflowParams.scale_name,
        root_note: workflowParams.root_note,
        tuning: workflowParams.tuning,
        fret_count: workflowParams.fret_count,
      } : undefined,
    },
    onData,
  });
}
