
export interface TranscriptionTurn {
  role: 'user' | 'assistant';
  text: string;
  timestamp: number;
}

export enum SessionState {
  DISCONNECTED = 'DISCONNECTED',
  CONNECTING = 'CONNECTING',
  CONNECTED = 'CONNECTED',
  ERROR = 'ERROR'
}
