
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenAI, Modality, Blob, LiveServerMessage } from '@google/genai';
import { decode, encode, decodeAudioData } from './utils';
import { UNIVERSITY_KNOWLEDGE_CONTEXT, MODEL_NAME } from './constants';
import { TranscriptionTurn, SessionState } from './types';

// Extend window for aistudio properties
declare global {
  interface AIStudio {
    hasSelectedApiKey: () => Promise<boolean>;
    openSelectKey: () => Promise<void>;
  }
  interface Window {
    webkitAudioContext: typeof AudioContext;
  }
}

const App: React.FC = () => {
  const [sessionState, setSessionState] = useState<SessionState>(SessionState.DISCONNECTED);
  const [transcriptionHistory, setTranscriptionHistory] = useState<TranscriptionTurn[]>([]);
  const [isModelTalking, setIsModelTalking] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const sessionRef = useRef<any>(null);
  const audioContextInRef = useRef<AudioContext | null>(null);
  const audioContextOutRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const micStreamRef = useRef<MediaStream | null>(null);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);

  // Refs for managing transcription assembly
  const currentInputText = useRef("");
  const currentOutputText = useRef("");

  const stopSession = useCallback(() => {
    if (sessionRef.current) {
      try {
        sessionRef.current.close();
      } catch (e) {
        console.warn("Error closing session:", e);
      }
      sessionRef.current = null;
    }
    
    if (scriptProcessorRef.current) {
      scriptProcessorRef.current.onaudioprocess = null;
      scriptProcessorRef.current.disconnect();
      scriptProcessorRef.current = null;
    }

    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach(track => track.stop());
      micStreamRef.current = null;
    }

    if (audioContextInRef.current) {
      audioContextInRef.current.close();
      audioContextInRef.current = null;
    }

    if (audioContextOutRef.current) {
      audioContextOutRef.current.close();
      audioContextOutRef.current = null;
    }

    sourcesRef.current.forEach(s => {
      try { s.stop(); } catch (e) {}
    });
    sourcesRef.current.clear();

    setSessionState(SessionState.DISCONNECTED);
    setIsModelTalking(false);
  }, []);

  const createBlob = (data: Float32Array): Blob => {
    const l = data.length;
    const int16 = new Int16Array(l);
    for (let i = 0; i < l; i++) {
      int16[i] = data[i] * 32768;
    }
    return {
      data: encode(new Uint8Array(int16.buffer)),
      mimeType: 'audio/pcm;rate=16000',
    };
  };

  const startSession = async () => {
    try {
      setErrorMessage(null);
      setSessionState(SessionState.CONNECTING);

      // Check for API key if the environment requires key selection
      if (window.aistudio) {
        const hasKey = await window.aistudio.hasSelectedApiKey();
        if (!hasKey) {
          await window.aistudio.openSelectKey();
        }
      }

      // Initialize API client fresh right before connect
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

      // Audio contexts
      audioContextInRef.current = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
      audioContextOutRef.current = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });

      // Request microphone
      micStreamRef.current = await navigator.mediaDevices.getUserMedia({ audio: true });

      const sessionPromise = ai.live.connect({
        model: MODEL_NAME,
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
          },
          systemInstruction: UNIVERSITY_KNOWLEDGE_CONTEXT,
          outputAudioTranscription: {},
          inputAudioTranscription: {},
        },
        callbacks: {
          onopen: () => {
            setSessionState(SessionState.CONNECTED);
            
            // Trigger the mandatory initial greeting
            sessionPromise.then((session: any) => {
              session.sendRealtimeInput({
                text: "Please provide your mandatory warm greeting to start the conversation."
              });
            }).catch(e => console.error("Initial send error:", e));

            // Start streaming microphone data
            const source = audioContextInRef.current!.createMediaStreamSource(micStreamRef.current!);
            const scriptProcessor = audioContextInRef.current!.createScriptProcessor(4096, 1, 1);
            scriptProcessorRef.current = scriptProcessor;
            
            scriptProcessor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const pcmBlob = createBlob(inputData);
              sessionPromise.then((session: any) => {
                session.sendRealtimeInput({ media: pcmBlob });
              }).catch(() => {});
            };

            source.connect(scriptProcessor);
            scriptProcessor.connect(audioContextInRef.current!.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
            // Audio Output Handling
            const base64Audio = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (base64Audio && audioContextOutRef.current) {
              setIsModelTalking(true);
              const ctx = audioContextOutRef.current;
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);
              
              const audioBuffer = await decodeAudioData(decode(base64Audio), ctx, 24000, 1);
              const source = ctx.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(ctx.destination);
              
              source.addEventListener('ended', () => {
                sourcesRef.current.delete(source);
                if (sourcesRef.current.size === 0) {
                  setIsModelTalking(false);
                }
              });

              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += audioBuffer.duration;
              sourcesRef.current.add(source);
            }

            // Interrupt Handling
            if (message.serverContent?.interrupted) {
              sourcesRef.current.forEach(s => {
                try { s.stop(); } catch (e) {}
              });
              sourcesRef.current.clear();
              nextStartTimeRef.current = 0;
              setIsModelTalking(false);
            }

            // Transcription Handling
            if (message.serverContent?.inputTranscription) {
              currentInputText.current += message.serverContent.inputTranscription.text;
            }
            if (message.serverContent?.outputTranscription) {
              currentOutputText.current += message.serverContent.outputTranscription.text;
            }

            if (message.serverContent?.turnComplete) {
              const input = currentInputText.current;
              const output = currentOutputText.current;
              
              if (input || output) {
                setTranscriptionHistory(prev => [
                  ...prev,
                  { role: 'user', text: input || "(Audio input)", timestamp: Date.now() },
                  { role: 'assistant', text: output || "(Audio response)", timestamp: Date.now() }
                ].filter(t => t.text.trim().length > 0 && !t.text.includes("Please provide your mandatory warm greeting"))); 
              }

              currentInputText.current = "";
              currentOutputText.current = "";
            }
          },
          onerror: (e: any) => {
            console.error("Session Error:", e);
            let message = "A connection error occurred. Please try again.";
            if (e?.message?.includes("Requested entity was not found")) {
               message = "Invalid API key or model. Please check your credentials.";
               if (window.aistudio) window.aistudio.openSelectKey();
            } else if (e?.message?.includes("Network error") || e?.type === "error") {
               message = "Network error: Unable to reach the voice server. Please verify your internet connection and API key project billing.";
            }
            setErrorMessage(message);
            stopSession();
          },
          onclose: (e: any) => {
            console.log("Session Closed", e);
            stopSession();
          }
        }
      });

      sessionRef.current = await sessionPromise;

    } catch (err: any) {
      console.error("Failed to start session:", err);
      setErrorMessage(err.message || "Could not access microphone or connect to server.");
      setSessionState(SessionState.DISCONNECTED);
      stopSession();
    }
  };

  useEffect(() => {
    return () => stopSession();
  }, [stopSession]);

  return (
    <div className="flex flex-col min-h-screen">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-6 py-4 shadow-sm flex items-center justify-between sticky top-0 z-10">
        <div className="flex items-center space-x-3">
          <div className="w-10 h-10 bg-indigo-600 rounded-lg flex items-center justify-center text-white font-bold text-xl">G</div>
          <h1 className="text-xl font-bold text-gray-800">GHRISTU Assistant</h1>
        </div>
        <div className="flex items-center space-x-2">
          <span className={`w-3 h-3 rounded-full ${
            sessionState === SessionState.CONNECTED ? 'bg-green-500' :
            sessionState === SessionState.CONNECTING ? 'bg-yellow-500 animate-pulse' : 'bg-gray-300'
          }`} />
          <span className="text-sm font-medium text-gray-600 capitalize">
            {sessionState.toLowerCase()}
          </span>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-grow flex flex-col items-center justify-center p-6 space-y-8">
        
        {/* Visual Assistant Area */}
        <div className="relative flex items-center justify-center w-64 h-64">
          <div className={`absolute inset-0 rounded-full bg-indigo-100 opacity-20 blur-3xl transition-transform duration-500 ${isModelTalking ? 'scale-150' : 'scale-100'}`}></div>
          <div className={`voice-orb w-48 h-48 rounded-full flex items-center justify-center shadow-2xl transition-all duration-300 ${
            sessionState === SessionState.CONNECTED ? 'bg-gradient-to-tr from-indigo-500 to-purple-500' : 'bg-gray-200'
          }`}>
             {sessionState === SessionState.CONNECTED ? (
               isModelTalking ? (
                 <div className="flex items-end space-x-1 h-12">
                   {[...Array(5)].map((_, i) => (
                     <div key={i} className="w-2 bg-white rounded-full animate-bounce" style={{ animationDelay: `${i * 0.1}s`, height: `${40 + Math.random() * 60}%` }}></div>
                   ))}
                 </div>
               ) : (
                 <svg xmlns="http://www.w3.org/2000/svg" className="h-16 w-16 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                   <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                 </svg>
               )
             ) : (
               <svg xmlns="http://www.w3.org/2000/svg" className="h-16 w-16 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                 <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11A7 7 0 0112 18m0 0A7 7 0 015 11m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
               </svg>
             )}
          </div>
        </div>

        {/* Text Area */}
        <div className="text-center space-y-4 max-w-md">
          {sessionState === SessionState.DISCONNECTED ? (
            <>
              <h2 className="text-2xl font-semibold text-gray-900">Welcome to GHRISTU University</h2>
              <p className="text-gray-600">Have a natural conversation about our programs, campus, and placements. I'm here to help.</p>
              <button 
                onClick={startSession}
                className="px-8 py-3 bg-indigo-600 text-white rounded-full font-bold shadow-lg hover:bg-indigo-700 active:scale-95 transition-all"
              >
                Start Conversation
              </button>
            </>
          ) : (
            <>
              <p className="text-lg font-medium text-gray-800 italic">
                {isModelTalking ? "Assistant is speaking..." : "Listening for your voice..."}
              </p>
              <button 
                onClick={stopSession}
                className="px-8 py-3 bg-red-50 text-red-600 border border-red-200 rounded-full font-bold hover:bg-red-100 active:scale-95 transition-all"
              >
                End Session
              </button>
            </>
          )}
          {errorMessage && (
            <div className="p-4 bg-red-50 border border-red-100 rounded-xl">
              <p className="text-red-500 text-sm font-medium">{errorMessage}</p>
            </div>
          )}
        </div>

        {/* Live Transcription Log */}
        {transcriptionHistory.length > 0 && (
          <div className="w-full max-w-2xl bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden mt-8">
            <div className="bg-gray-50 px-4 py-2 border-b border-gray-100 flex justify-between items-center">
              <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Conversation History</span>
              <button onClick={() => setTranscriptionHistory([])} className="text-xs text-indigo-500 hover:underline">Clear History</button>
            </div>
            <div className="max-h-64 overflow-y-auto p-4 space-y-4">
              {transcriptionHistory.map((turn, i) => (
                <div key={i} className={`flex ${turn.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[80%] rounded-2xl px-4 py-2 text-sm ${
                    turn.role === 'user' 
                      ? 'bg-indigo-600 text-white rounded-tr-none' 
                      : 'bg-gray-100 text-gray-800 rounded-tl-none shadow-inner'
                  }`}>
                    {turn.text}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="bg-white border-t border-gray-100 py-4 px-6 text-center text-xs text-gray-400">
        &copy; {new Date().getFullYear()} GHRISTU University. All rights reserved. Skill Tech Education for the Future.
      </footer>
    </div>
  );
};

export default App;
