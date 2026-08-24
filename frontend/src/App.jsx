import React, { useState, useEffect, useRef } from 'react';
import { io } from 'socket.io-client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Mic, MicOff, Video, VideoOff, Loader2, Smartphone, SwitchCamera } from 'lucide-react';
import { sampleBackgroundLighting } from './lib/colorGrading';
import { createVirtualCam } from './lib/virtualcam';

const SOCKET_SERVER_URL = `https://photobooth.aloo.gay`;

const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    {
      urls: "turn:openrelay.metered.ca:80",
      username: "openrelayproject",
      credential: "openrelayproject"
    },
    {
      urls: "turn:openrelay.metered.ca:443",
      username: "openrelayproject",
      credential: "openrelayproject"
    },
    {
      urls: "turn:openrelay.metered.ca:443?transport=tcp",
      username: "openrelayproject",
      credential: "openrelayproject"
    }
  ]
};

function App() {
  const [roomId, setRoomId] = useState('');
  const [inRoom, setInRoom] = useState(false);
  const [hasVideo, setHasVideo] = useState(false);
  const [copied, setCopied] = useState(false);
  const [isFriendConnected, setIsFriendConnected] = useState(false);
  const [ping, setPing] = useState(null);
  const [isMuted, setIsMuted] = useState(false);
  const [isVideoOff, setIsVideoOff] = useState(false);
  const [mlLoaded, setMlLoaded] = useState(false);
  const [selectedBg, setSelectedBg] = useState('/backgrounds/cafe.jpg');
  const [lighting, setLighting] = useState({ tint: [1, 1, 1], luminance: 0.5 });
  const [localDepth, setLocalDepth] = useState(1.0);
  const [remoteDepth, setRemoteDepth] = useState(1.0);
  const [videoDevices, setVideoDevices] = useState([]);
  const [selectedVideoDeviceId, setSelectedVideoDeviceId] = useState('');
  
  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const rawVideoRef = useRef(null);
  const canvasRef = useRef(null);
  const bgImageRef = useRef(null);
  const animationFrameRef = useRef(null);
  
  const virtualCamSessionRef = useRef(null);
  const socketRef = useRef(null);
  const peerConnectionRef = useRef(null);
  const localStreamRef = useRef(null);
  const webrtcStreamRef = useRef(null);
  const remoteStreamRef = useRef(null);
  const iceCandidatesQueue = useRef([]);
  const otherUserIdRef = useRef(null);
  const audioSenderRef = useRef(null);
  const videoSenderRef = useRef(null);
  const lastDepthEmitTimeRef = useRef(0);

  useEffect(() => {
    // Check for room in URL
    const params = new URLSearchParams(window.location.search);
    const roomParam = params.get('room');
    if (roomParam) {
      setRoomId(roomParam);
    }

    setMlLoaded(true);

    socketRef.current = io(SOCKET_SERVER_URL);

    socketRef.current.on('user-connected', async (userId) => {
      console.log('User connected:', userId);
      await createOffer(userId);
    });

    socketRef.current.on('offer', async (payload) => {
      console.log('Received offer from:', payload.caller);
      await handleOffer(payload);
    });

    socketRef.current.on('answer', async (payload) => {
      console.log('Received answer from:', payload.callee);
      await handleAnswer(payload);
    });

    socketRef.current.on('ice-candidate', async (payload) => {
      try {
        if (peerConnectionRef.current) {
          const candidate = new RTCIceCandidate(payload.candidate);
          if (peerConnectionRef.current.remoteDescription && peerConnectionRef.current.remoteDescription.type) {
            peerConnectionRef.current.addIceCandidate(candidate).catch(e => {
              console.warn("Ignored stale ICE candidate:", e.message);
            });
          } else {
            iceCandidatesQueue.current.push(candidate);
          }
        }
      } catch (e) {
        console.error('Error constructing ice candidate', e);
      }
    });

    socketRef.current.on('change-background', (bgUrl) => {
      setSelectedBg(bgUrl);
    });

    socketRef.current.on('depth-update', (depth) => {
      setRemoteDepth(depth);
    });

    socketRef.current.on('user-disconnected', (userId) => {
      console.log('User disconnected:', userId);
      setIsFriendConnected(false);
      remoteStreamRef.current = null;
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = null;
      }
      if (peerConnectionRef.current) {
        peerConnectionRef.current.close();
        peerConnectionRef.current = null;
      }
    });

    return () => {
      if (socketRef.current) {
        socketRef.current.disconnect();
      }
    };
  }, []);

  useEffect(() => {
    if (inRoom && localVideoRef.current && localStreamRef.current) {
      localVideoRef.current.srcObject = localStreamRef.current;
    }
    if (inRoom && remoteVideoRef.current && remoteStreamRef.current) {
      remoteVideoRef.current.srcObject = remoteStreamRef.current;
    }
  }, [inRoom, hasVideo, isFriendConnected]);

  useEffect(() => {
    let interval;
    if (inRoom && isFriendConnected) {
      interval = setInterval(async () => {
        if (!peerConnectionRef.current) return;
        try {
          const stats = await peerConnectionRef.current.getStats();
          let currentPing = null;
          stats.forEach(stat => {
            if (stat.type === 'candidate-pair' && stat.state === 'succeeded') {
              if (stat.currentRoundTripTime !== undefined) {
                currentPing = Math.round(stat.currentRoundTripTime * 1000);
              }
            }
          });
          setPing(currentPing);
        } catch (e) {
          console.error('Error getting stats', e);
        }
      }, 1000);
    } else {
      setPing(null);
    }
    return () => clearInterval(interval);
  }, [inRoom, isFriendConnected]);

  useEffect(() => {
    const img = new Image();
    img.crossOrigin = "Anonymous";
    img.onload = () => {
      const result = sampleBackgroundLighting(img);
      setLighting(result);
    };
    img.src = selectedBg;
    
    if (virtualCamSessionRef.current) {
      virtualCamSessionRef.current.setBackground({ type: 'image', src: selectedBg });
    }
  }, [selectedBg]);

  const getMedia = async (requestedDeviceId = null) => {
    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error("Camera API is not supported in this browser or requires HTTPS.");
      }
      
      const videoConstraints = requestedDeviceId 
        ? { deviceId: { exact: requestedDeviceId }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }
        : { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } };

      const rawStream = await navigator.mediaDevices.getUserMedia({ 
        video: videoConstraints, 
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        } 
      });
      
      // Enumerate devices now that permissions are granted
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoInputs = devices.filter(d => d.kind === 'videoinput');
      setVideoDevices(videoInputs);
      
      if (requestedDeviceId) {
         setSelectedVideoDeviceId(requestedDeviceId);
      } else if (videoInputs.length > 0) {
         const activeTrack = rawStream.getVideoTracks()[0];
         const activeDevice = videoInputs.find(d => d.label === activeTrack.label);
         setSelectedVideoDeviceId(activeDevice ? activeDevice.deviceId : videoInputs[0].deviceId);
      }

      if (virtualCamSessionRef.current) {
        virtualCamSessionRef.current.destroy();
      }
      
      const vcam = await createVirtualCam(rawStream, {
        background: { type: 'image', src: selectedBg },
        downsampleRatio: 0.25,
        modelUrl: '/models/rvm_mobilenetv3_fp32.onnx'
      });
      
      virtualCamSessionRef.current = vcam;
      localStreamRef.current = vcam.outputStream;
      webrtcStreamRef.current = vcam.outputStream;
      
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = vcam.outputStream;
      }
      setHasVideo(true);

      if (isVideoOff) rawStream.getVideoTracks().forEach(t => t.enabled = false);
      if (isMuted) rawStream.getAudioTracks().forEach(t => t.enabled = false);

    } catch (err) {
      console.error("Error accessing media devices.", err);
      const msg = (err && err.message) ? err.message : String(err);
      alert(`Could not access camera/microphone: ${msg}. Please allow permissions.`);
    }
  };

  const cycleCamera = async () => {
    if (videoDevices.length <= 1) return;
    
    try {
      const currentIndex = videoDevices.findIndex(d => d.deviceId === selectedVideoDeviceId);
      const nextIndex = (currentIndex + 1) % videoDevices.length;
      const nextDeviceId = videoDevices[nextIndex].deviceId;
      
      // We need to re-initialize everything with the new device
      await getMedia(nextDeviceId);
      
      // Update WebRTC connection with the new streams
      if (peerConnectionRef.current && webrtcStreamRef.current) {
         const newAudioTrack = webrtcStreamRef.current.getAudioTracks()[0];
         const newVideoTrack = webrtcStreamRef.current.getVideoTracks()[0];
         
         const senders = peerConnectionRef.current.getSenders();
         
         if (newAudioTrack) {
           const audioSender = senders.find(s => s.track && s.track.kind === 'audio');
           if (audioSender) audioSender.replaceTrack(newAudioTrack);
         }
         
         if (newVideoTrack) {
           const videoSender = senders.find(s => s.track && s.track.kind === 'video');
           if (videoSender) videoSender.replaceTrack(newVideoTrack);
         }
      }
    } catch (e) {
      console.error("Failed to switch camera", e);
    }
  };

  const createPeerConnection = () => {
    const pc = new RTCPeerConnection(ICE_SERVERS);
    
    pc.ontrack = (event) => {
      console.log('Received remote track', event.streams[0]);
      remoteStreamRef.current = event.streams[0];
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = event.streams[0];
      }
      setIsFriendConnected(true);
    };

    if (webrtcStreamRef.current) {
      webrtcStreamRef.current.getTracks().forEach(track => {
        const sender = pc.addTrack(track, webrtcStreamRef.current);
        if (track.kind === 'audio') audioSenderRef.current = sender;
        if (track.kind === 'video') videoSenderRef.current = sender;
      });
    }

    return pc;
  };

  const initPeerConnection = () => {
    if (!peerConnectionRef.current || peerConnectionRef.current.signalingState === "closed") {
       peerConnectionRef.current = createPeerConnection();
       iceCandidatesQueue.current = [];
       
       peerConnectionRef.current.onicecandidate = (event) => {
         if (event.candidate && otherUserIdRef.current) {
           socketRef.current.emit('ice-candidate', {
             target: otherUserIdRef.current,
             candidate: event.candidate
           });
         }
       };
    }
  }

  const flushIceCandidates = async () => {
    while (iceCandidatesQueue.current.length > 0) {
      const candidate = iceCandidatesQueue.current.shift();
      if (peerConnectionRef.current && peerConnectionRef.current.remoteDescription) {
        peerConnectionRef.current.addIceCandidate(candidate).catch(e => console.warn("Ignored stale queued candidate:", e.message));
      }
    }
  };

  const createOffer = async (userId) => {
    otherUserIdRef.current = userId;
    initPeerConnection();
    
    const offer = await peerConnectionRef.current.createOffer();
    await peerConnectionRef.current.setLocalDescription(offer);
    
    socketRef.current.emit('offer', {
      target: userId,
      sdp: peerConnectionRef.current.localDescription
    });
  };

  const handleOffer = async (payload) => {
    try {
      otherUserIdRef.current = payload.caller;
      
      // Force kill any stuck/stale peer connection to prevent signaling state collisions
      if (peerConnectionRef.current && peerConnectionRef.current.signalingState !== "closed") {
         peerConnectionRef.current.close();
      }
      peerConnectionRef.current = null;
      iceCandidatesQueue.current = [];
      
      initPeerConnection();
      
      await peerConnectionRef.current.setRemoteDescription(new RTCSessionDescription(payload.sdp));
      await flushIceCandidates();

      const answer = await peerConnectionRef.current.createAnswer();
      await peerConnectionRef.current.setLocalDescription(answer);
      
      socketRef.current.emit('answer', {
        target: payload.caller,
        sdp: peerConnectionRef.current.localDescription
      });
    } catch (e) {
      console.error("Critical error in handleOffer:", e);
    }
  };

  const handleAnswer = async (payload) => {
    const desc = new RTCSessionDescription(payload.sdp);
    await peerConnectionRef.current.setRemoteDescription(desc).catch(e => console.error(e));
    await flushIceCandidates();
  };

  const joinRoom = async (idToJoin) => {
    if (idToJoin.trim() === '') return;
    
    const newurl = window.location.protocol + "//" + window.location.host + window.location.pathname + '?room=' + idToJoin;
    window.history.pushState({path:newurl},'',newurl);
    
    await getMedia();
    setInRoom(true);
    socketRef.current.emit('join-room', idToJoin);
  };

  const handleJoinSubmit = (e) => {
    e.preventDefault();
    joinRoom(roomId);
  };

  const handleCreateRoom = () => {
    const newRoomId = Math.random().toString(36).substring(2, 8);
    setRoomId(newRoomId);
    joinRoom(newRoomId);
  };

  const copyInviteLink = () => {
    const link = window.location.href;
    navigator.clipboard.writeText(link);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const toggleMute = () => {
    if (webrtcStreamRef.current) {
        const audioTrack = webrtcStreamRef.current.getAudioTracks()[0];
        if (audioTrack) {
          audioTrack.enabled = !audioTrack.enabled;
          setIsMuted(!audioTrack.enabled);
        }
    }
  };

  const toggleVideo = () => {
    if (webrtcStreamRef.current) {
      const videoTrack = webrtcStreamRef.current.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.enabled = !videoTrack.enabled;
        setIsVideoOff(!videoTrack.enabled);
      }
    }
  };

  const webrtcCanvasRef = useRef(null);

  if (!mlLoaded) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center p-4">
        <Loader2 className="animate-spin mb-4 text-primary" size={48} />
        <h2 className="text-xl font-semibold">Loading AI Environment...</h2>
        <p className="text-muted-foreground mt-2 text-center max-w-sm">
          Preparing the neural network for cozy background removal.
        </p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col items-center justify-center p-4">

      {/* Portrait Mode Warning Overlay */}
      <div className="portrait:flex landscape:hidden fixed inset-0 z-[100] bg-background/95 backdrop-blur-md flex-col items-center justify-center p-6 text-center">
        <Smartphone className="w-24 h-24 mb-6 text-primary animate-[pulse_2s_ease-in-out_infinite]" />
        <h2 className="text-3xl font-bold mb-3">Rotate Your Device</h2>
        <p className="text-muted-foreground max-w-sm text-lg">
          The Virtual Photobooth requires a landscape view so your camera can cover the entire background. Please turn your phone sideways!
        </p>
      </div>
      
      {!inRoom ? (
        <div className="w-full max-w-md p-8 border rounded-xl shadow-sm bg-card flex flex-col items-center gap-6">
          <div className="text-center">
            <h1 className="text-3xl font-bold tracking-tight mb-2">Virtual Photobooth</h1>
            <p className="text-sm text-muted-foreground">Create a new room or join an existing one to start a video call with a friend.</p>
          </div>
          
          <Button onClick={handleCreateRoom} className="w-full text-lg h-12">
            Create New Room
          </Button>

          <div className="flex items-center w-full">
            <div className="flex-grow border-t border-muted"></div>
            <span className="px-3 text-xs text-muted-foreground uppercase tracking-wider">or</span>
            <div className="flex-grow border-t border-muted"></div>
          </div>
          
          <form onSubmit={handleJoinSubmit} className="w-full flex flex-col gap-3">
            <Input 
              type="text" 
              placeholder="Paste Room ID here" 
              value={roomId}
              onChange={(e) => setRoomId(e.target.value)}
              className="w-full text-center h-12"
            />
            <Button variant="outline" type="submit" className="w-full h-12">
              Join Room
            </Button>
          </form>
        </div>
      ) : (
        <div className="w-full max-w-5xl flex flex-col gap-6">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between bg-card p-4 rounded-xl border shadow-sm gap-4">
            <div>
              <h2 className="text-lg font-semibold">Room Code: <span className="text-primary tracking-wider">{roomId}</span></h2>
              <p className="text-xs text-muted-foreground">Send this link to your friend to join the photobooth</p>
            </div>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={copyInviteLink}>
                {copied ? "Copied!" : "Copy Link"}
              </Button>
              <Button variant="destructive" onClick={() => window.location.href = '/'}>
                Leave Room
              </Button>
            </div>
          </div>
          
          {/* Main Rendering Area */}
          <div className="relative w-full aspect-video rounded-2xl overflow-hidden bg-black/50 border shadow-inner flex items-center justify-center" style={{ backgroundImage: selectedBg ? `url(${selectedBg})` : 'none', backgroundSize: 'cover', backgroundPosition: 'center' }}>
            
            {!inRoom && !hasVideo ? (
              <div className="flex flex-col items-center justify-center gap-3 text-muted-foreground animate-in fade-in zoom-in duration-500">
                 <Camera size={48} className="opacity-20" />
                 <p>Initializing camera...</p>
              </div>
            ) : (
              <div className="w-full h-full relative" style={{ zIndex: 10 }}>
                {/* Background is pre-composited! We just render the stream */}
                <video 
                  ref={localVideoRef} 
                  autoPlay 
                  playsInline 
                  muted 
                  className={`absolute inset-0 w-full h-full object-cover transition-opacity duration-1000 transform -scale-x-100 ${isFriendConnected ? 'opacity-100 z-20 w-48 h-auto shadow-xl border rounded-lg bottom-4 right-4 left-auto top-auto' : 'opacity-100'}`} 
                />
                
                <video 
                  ref={remoteVideoRef} 
                  autoPlay 
                  playsInline 
                  className={`absolute inset-0 w-full h-full object-cover transition-opacity duration-1000 transform -scale-x-100 ${isFriendConnected ? 'opacity-100 z-10' : 'opacity-0'}`} 
                />
              </div>
            )}
             
             {/* UI Overlays */}
             {!isFriendConnected && (
                <div className="absolute inset-0 flex flex-col items-center justify-center text-white bg-black/40 z-10">
                  <div className="animate-pulse w-12 h-12 rounded-full bg-white/20 flex items-center justify-center mb-4">
                     Wait
                  </div>
                  Waiting for friend to join...
                </div>
             )}
             
             {ping !== null && isFriendConnected && (
               <div className="absolute top-4 right-4 bg-black/60 text-white backdrop-blur px-3 py-1 rounded-md text-xs font-medium border shadow-sm flex items-center gap-2 z-10">
                 <div className={`w-2 h-2 rounded-full ${ping < 100 ? 'bg-green-500' : ping < 200 ? 'bg-yellow-500' : 'bg-red-500'}`}></div>
                 {ping} ms
               </div>
             )}
          </div>
          
          {/* Media Controls */}
          <div className="flex flex-col sm:flex-row gap-4 mt-2">
            
            {/* Background Selector */}
            <div className="flex-grow bg-card p-4 rounded-xl border shadow-sm flex flex-col gap-2">
              <h3 className="text-sm font-medium">Virtual Background (Synced)</h3>
              <div className="flex gap-4 overflow-x-auto pb-2">
                <div 
                  onClick={() => {
                    setSelectedBg(null);
                    socketRef.current.emit('change-background', { roomId, bgUrl: null });
                  }} 
                  className={`w-24 h-16 shrink-0 rounded-md border-2 flex items-center justify-center cursor-pointer bg-muted text-xs ${!selectedBg ? 'border-primary' : 'border-transparent'}`}
                >
                  Off
                </div>
                {['/backgrounds/cafe.jpg', '/backgrounds/cabin.jpg', '/backgrounds/library.jpg'].map((bg) => (
                  <img 
                    key={bg}
                    onClick={() => {
                      setSelectedBg(bg);
                      socketRef.current.emit('change-background', { roomId, bgUrl: bg });
                    }} 
                    src={bg} 
                    className={`w-24 h-16 shrink-0 rounded-md object-cover border-2 cursor-pointer ${selectedBg === bg ? 'border-primary' : 'border-transparent'}`} 
                    alt="bg"
                  />
                ))}
              </div>
            </div>

            <div className="flex justify-center items-center gap-6 bg-card p-4 rounded-xl border shadow-sm shrink-0">
              <Button 
                variant={isMuted ? "destructive" : "secondary"} 
                onClick={toggleMute} 
                className="w-16 h-16 rounded-full"
              >
                {isMuted ? <MicOff size={24} /> : <Mic size={24} />}
              </Button>
              <Button 
                variant={isVideoOff ? "destructive" : "secondary"} 
                onClick={toggleVideo} 
                className="w-16 h-16 rounded-full"
              >
                {isVideoOff ? <VideoOff size={24} /> : <Video size={24} />}
              </Button>
              {videoDevices.length > 1 && (
                <Button 
                  variant="secondary" 
                  onClick={cycleCamera} 
                  className="w-16 h-16 rounded-full"
                >
                  <SwitchCamera size={24} />
                </Button>
              )}
            </div>
          </div>

        </div>
      )}
    </div>
  );
}

export default App;
