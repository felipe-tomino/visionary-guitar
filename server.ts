import 'dotenv/config';
import express from 'express';
import { join } from 'path';
import { InferenceHTTPClient } from '@roboflow/inference-sdk';

const app = express();
const PORT = process.env.PORT || 5189;

app.use(express.json());

// Serve static files in production
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(join(process.cwd(), 'dist')));
}

// WebRTC proxy endpoint
app.post('/api/init-webrtc', async (req, res) => {
  const apiKey = process.env.ROBOFLOW_API_KEY;

  if (!apiKey) {
    return res.status(500).json({ error: 'ROBOFLOW_API_KEY not configured' });
  }

  try {
    const { offer, wrtcParams } = req.body;

    const client = InferenceHTTPClient.init({ apiKey });

    const answer = await client.initializeWebrtcWorker({
      offer,
      workflowSpec: wrtcParams.workflowSpec,
      workspaceName: wrtcParams.workspaceName,
      workflowId: wrtcParams.workflowId,
      config: {
        imageInputName: wrtcParams.imageInputName,
        streamOutputNames: wrtcParams.streamOutputNames,
        dataOutputNames: wrtcParams.dataOutputNames,
        threadPoolWorkers: wrtcParams.threadPoolWorkers,
        workflowsParameters: wrtcParams.workflowsParameters,
        iceServers: wrtcParams.iceServers,
        processingTimeout: wrtcParams.processingTimeout,
        requestedPlan: wrtcParams.requestedPlan,
        requestedRegion: wrtcParams.requestedRegion,
      },
    });

    res.json(answer);
  } catch (error) {
    console.error('Error initializing WebRTC:', error);
    res.status(500).json({ error: 'Failed to initialize WebRTC connection' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
