import { useRef, useState } from "react";
import { createClient } from "@anam-ai/js-sdk";
const { MicVAD, utils } = window.vad;
//const API_URL = "http://localhost:8000";
const API_URL = "";

function AvatarWidget() {
    const videoRef = useRef(null);
    const anamClientRef = useRef(null);
    const anamAudioStreamRef = useRef(null);

    // --------------------------------------------------
    // VOICE ACTIVITY DETECTION
    // --------------------------------------------------

    const vadRef = useRef(null);
    const vadStartingRef = useRef(false);
    const vadRunningRef = useRef(false);
    const conversationActiveRef = useRef(false);
    const processingSpeechRef = useRef(false);
    const avatarSpeakingRef = useRef(false);
    const avatarPlaybackActiveRef = useRef(false);

    // --------------------------------------------------
    // TTS AUDIO BUFFER / QUEUE
    // --------------------------------------------------

    // Cartesia returns raw PCM signed 16-bit little-endian audio at 16 kHz.
    // The Anam audio input stream is configured for the same format.
    const AUDIO_SAMPLE_RATE = 16000;
    const AUDIO_CHANNELS = 1;
    const BYTES_PER_SAMPLE = 2;
    const PCM_BYTES_PER_SECOND =
        AUDIO_SAMPLE_RATE * AUDIO_CHANNELS * BYTES_PER_SAMPLE;

    // 1280 bytes = 40 ms of 16 kHz, mono, PCM16 audio.
    const PCM_FRAME_SIZE = 1280;
    const INITIAL_BUFFER_SIZE = 6400; // 200 ms
    const PLAYBACK_COMPLETION_PADDING_MS = 500;

    const ttsQueueRef = useRef([]);
    const pcmBufferRef = useRef(new Uint8Array(0));
    const ttsPlaybackStartedRef = useRef(false);
    const ttsPlaybackStartedAtRef = useRef(null);
    const ttsGenerationIdRef = useRef(0);

    // Prevent microphone capture while the lead form is displayed.
    const leadFormActiveRef = useRef(false);

    // --------------------------------------------------
    // STATE
    // --------------------------------------------------

    const [status, setStatus] = useState("idle");
    const [error, setError] = useState("");

    const [ttsStatus, setTtsStatus] = useState("idle");

    const [isListening, setIsListening] = useState(false);
    const [transcript, setTranscript] = useState("");
    const [chatStatus, setChatStatus] = useState("idle");
    const [chatAnswer, setChatAnswer] = useState("");

    // --------------------------------------------------
    // LEAD FORM STATE
    // --------------------------------------------------

    const [showLeadForm, setShowLeadForm] = useState(false);

    const [leadForm, setLeadForm] = useState({
        name: "",
        email: "",
        phone: "",
    });

    const [leadSubmitting, setLeadSubmitting] = useState(false);

    const [leadSubmitted, setLeadSubmitted] = useState(false);

    const [leadError, setLeadError] = useState("");


    const initializeVAD = async () => {
        if (vadRef.current || vadStartingRef.current) {
            return;
        }

        try {
            vadStartingRef.current = true;

            console.log("Initializing VAD...");

            const vad = await MicVAD.new({
                model: "v6",
                baseAssetPath: "https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.31/dist/",
                onnxWASMBasePath: "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/",

                startOnLoad: false,

                redemptionMs: 500,
                preSpeechPadMs: 800,
                minSpeechMs: 400,

                positiveSpeechThreshold: 0.3,
                negativeSpeechThreshold: 0.25,

                onSpeechStart: () => {
                    if (
                        !conversationActiveRef.current ||
                        processingSpeechRef.current ||
                        avatarSpeakingRef.current
                    ) {
                        return;
                    }

                    console.log("🎤 USER SPEECH START");

                    setIsListening(true);
                    setChatStatus("idle");
                    setError("");
                },

                onSpeechEnd: async (audio) => {
                    if (
                        !conversationActiveRef.current ||
                        processingSpeechRef.current ||
                        avatarSpeakingRef.current
                    ) {
                        return;
                    }

                    processingSpeechRef.current = true;

                    console.log("🛑 USER SPEECH END");

                    setIsListening(false);

                    // Pause capture while this utterance is transcribed and answered.
                    await stopVAD();

                    try {
                        const wavBuffer = utils.encodeWAV(audio);

                        const audioBlob = new Blob(
                            [wavBuffer],
                            {
                                type: "audio/wav",
                            }
                        );

                        console.log(
                            "VAD audio size:",
                            audioBlob.size
                        );

                        await sendAudioToWhisper(audioBlob);

                    } catch (err) {
                        console.error(
                            "VAD processing error:",
                            err
                        );

                        setChatStatus("error");

                        setError(
                            err?.message ||
                            "Failed to process your speech."
                        );

                    } finally {
                        processingSpeechRef.current = false;

                        // Restart listening only after the complete chat/TTS
                        // cycle has finished and no lead form is blocking input.
                        if (
                            conversationActiveRef.current &&
                            !avatarSpeakingRef.current &&
                            !leadFormActiveRef.current
                        ) {
                            await startVAD();
                        }
                    }
                },

                onVADMisfire: () => {
                    console.log("VAD misfire");
                    setIsListening(false);
                },
            });

            vadRef.current = vad;

            console.log("VAD initialized.");

        } catch (err) {

            console.error(
                "VAD initialization error:",
                err
            );

            setError(
                err?.message ||
                "Failed to initialize microphone."
            );

        } finally {
            vadStartingRef.current = false;
        }
    };


    const startVAD = async () => {
        if (!vadRef.current) {
            await initializeVAD();
        }

        if (
            !vadRef.current ||
            !conversationActiveRef.current ||
            processingSpeechRef.current ||
            avatarSpeakingRef.current ||
            leadFormActiveRef.current ||
            vadRunningRef.current
        ) {
            return;
        }

        try {
            console.log("Starting VAD...");
            await vadRef.current.start();
            vadRunningRef.current = true;

            // If the session ended while start() was pending, stop immediately.
            if (
                !conversationActiveRef.current ||
                leadFormActiveRef.current
            ) {
                await stopVAD();
                return;
            }

            console.log("VAD listening for speech.");
        } catch (err) {
            vadRunningRef.current = false;
            console.error("Failed to start VAD:", err);
            setError(
                err?.message || "Could not start microphone."
            );
        }
    };


    const stopVAD = async () => {
        if (!vadRef.current || !vadRunningRef.current) {
            setIsListening(false);
            return;
        }

        try {
            console.log("Stopping VAD...");
            await vadRef.current.pause();
        } catch (err) {
            console.error("Failed to stop VAD:", err);
        } finally {
            vadRunningRef.current = false;
            setIsListening(false);
        }
    };


    // --------------------------------------------------
    // START ANAM AVATAR
    // --------------------------------------------------

    const startAvatar = async () => {
        try {
            setStatus("connecting");
            setError("");

            const response = await fetch(
                `${API_URL}/api/avatar-token`
            );

            const data = await response.json().catch(() => ({}));

            if (!response.ok) {
                console.error("Avatar token API error:", data);

                throw new Error(
                    typeof data.detail === "object"
                        ? JSON.stringify(data.detail)
                        : data.detail || `Failed to get Anam token: ${response.status}`
                );
            }

            if (!data.session_token) {
                throw new Error("The backend did not return an Anam session token.");
            }

            console.log("Anam session token received");

            const anamClient = createClient(
                data.session_token,
                {
                    disableInputAudio: true,
                }
            );

            anamClientRef.current = anamClient;

            await anamClient.streamToVideoElement(
                "anam-avatar-video"
            );

            // Initialize external TTS audio input
            const audioStream =
                anamClient.createAgentAudioInputStream({
                    encoding: "pcm_s16le",
                    sampleRate: 16000,
                    channels: 1,
                });

            anamAudioStreamRef.current = audioStream;
            console.log("Anam avatar connected");

            conversationActiveRef.current = true;
            vadRunningRef.current = false;
            avatarSpeakingRef.current = false;
            avatarPlaybackActiveRef.current = false;

            setStatus("connected");

            // ------------------------------------------
            // INITIAL GREETING
            // ------------------------------------------

            console.log("Initializing conversation greeting...");

            const greeting = 
                "Hello, and welcome to Webenza. I'm your AI assistant, here to help you learn more about our services, solutions, capabilities, and expertise. Feel free to ask me anything about Webenza or our offerings, and I'll provide the information I have to help you. Whenever you're ready, let's get started.";

            const greetingSpoken = await speakAnswer(greeting);

            if (!conversationActiveRef.current) {
                return;
            }

            if (!greetingSpoken) {
                console.warn("Initial greeting could not be played.");
            }

            // Start microphone only after the greeting finishes.
            await startVAD();

        } catch (err) {
            console.error("Anam avatar error:", err);

            conversationActiveRef.current = false;
            avatarSpeakingRef.current = false;
            avatarPlaybackActiveRef.current = false;

            await stopVAD();

            const client = anamClientRef.current;
            anamClientRef.current = null;
            anamAudioStreamRef.current = null;

            if (client) {
                try {
                    await client.stopStreaming();
                } catch (stopError) {
                    console.warn("Could not clean up failed Anam session:", stopError);
                }
            }

            setStatus("error");
            setError(
                err?.message || "Failed to connect to Anam avatar"
            );
        }
    };

    // --------------------------------------------------
    // RESET TTS BUFFER
    // --------------------------------------------------

    const resetTTSBuffer = () => {
        console.log("Resetting TTS audio buffer.");

        ttsQueueRef.current = [];
        pcmBufferRef.current = new Uint8Array(0);
        ttsPlaybackStartedRef.current = false;
        ttsPlaybackStartedAtRef.current = null;
    };

    // --------------------------------------------------
    // STOP ANAM AVATAR
    // --------------------------------------------------

    const stopAvatar = async () => {
        // Invalidate any TTS request that is still reading or waiting for playback.
        ttsGenerationIdRef.current++;

        conversationActiveRef.current = false;
        avatarSpeakingRef.current = false;
        avatarPlaybackActiveRef.current = false;
        leadFormActiveRef.current = false;

        await stopVAD();
        vadRunningRef.current = false;

        const client = anamClientRef.current;
        anamClientRef.current = null;
        anamAudioStreamRef.current = null;

        if (client) {
            try {
                await client.stopStreaming();
            } catch (err) {
                console.error("Error stopping Anam session:", err);
            }
        }

        resetTTSBuffer();

        setIsListening(false);
        setShowLeadForm(false);
        setStatus("idle");
        setTtsStatus("idle");
    };

    // --------------------------------------------------
    // APPEND PCM DATA TO BUFFER
    // --------------------------------------------------

    const appendPCMData = (newData) => {
        const existing =
            pcmBufferRef.current;

        const combined =
            new Uint8Array(
                existing.length +
                newData.length
            );

        combined.set(existing, 0);

        combined.set(
            newData,
            existing.length
        );

        pcmBufferRef.current =
            combined;
    };

    // --------------------------------------------------
    // CREATE FIXED SIZE PCM FRAMES
    // --------------------------------------------------

    const createPCMFrames = () => {
        const buffer =
            pcmBufferRef.current;

        if (
            buffer.length <
            PCM_FRAME_SIZE
        ) {
            return;
        }

        let offset = 0;

        while (
            buffer.length - offset >=
            PCM_FRAME_SIZE
        ) {
            const frame =
                buffer.slice(
                    offset,
                    offset +
                        PCM_FRAME_SIZE
                );

            ttsQueueRef.current.push(
                frame
            );

            offset += PCM_FRAME_SIZE;
        }

        pcmBufferRef.current =
            buffer.slice(offset);

        console.log(
            "PCM frames created:",
            ttsQueueRef.current.length
        );

        console.log(
            "Remaining PCM bytes:",
            pcmBufferRef.current.length
        );
    };

    // --------------------------------------------------
    // TTS QUEUE CONSUMER
    // --------------------------------------------------

    const consumeTTSQueue = async () => {
        if (!anamAudioStreamRef.current) {
            throw new Error("Anam audio input stream is unavailable.");
        }

        while (ttsQueueRef.current.length > 0) {
            const audioFrame = ttsQueueRef.current.shift();

            if (!audioFrame || audioFrame.length === 0) {
                continue;
            }

            if (ttsPlaybackStartedAtRef.current === null) {
                ttsPlaybackStartedAtRef.current = Date.now();
            }

            // Anam's agent audio input stream accepts Base64 PCM chunks.
            const base64Audio = btoa(
                String.fromCharCode(...audioFrame)
            );

            await anamAudioStreamRef.current.sendAudioChunk(base64Audio);
        }
    };

    // --------------------------------------------------
    // SPEAK CHATBOT ANSWER
    // --------------------------------------------------

    const speakAnswer = async (text) => {
        if (!text || !text.trim()) {
            return false;
        }

        const generationId = ++ttsGenerationIdRef.current;

        avatarSpeakingRef.current = true;
        avatarPlaybackActiveRef.current = true;

        // Stop microphone/VAD while the avatar is speaking.
        await stopVAD();

        try {
            if (!anamAudioStreamRef.current) {
                throw new Error("Anam avatar is not connected.");
            }

            setTtsStatus("generating");
            setError("");

            ttsQueueRef.current = [];
            pcmBufferRef.current = new Uint8Array(0);
            ttsPlaybackStartedRef.current = false;
            ttsPlaybackStartedAtRef.current = null;

            console.log("Starting Cartesia TTS generation...");
            console.log("TTS generation ID:", generationId);

            const response = await fetch(`${API_URL}/api/tts`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({ text }),
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`TTS failed: ${errorText}`);
            }

            if (!response.body) {
                throw new Error("TTS response does not support streaming.");
            }

            const reader = response.body.getReader();
            let totalBytes = 0;
            let networkChunkNumber = 0;

            while (true) {
                const { value, done } = await reader.read();

                if (generationId !== ttsGenerationIdRef.current) {
                    console.log("TTS request was cancelled because the session changed.");
                    try {
                        await reader.cancel();
                    } catch (cancelError) {
                        console.warn("Could not cancel TTS reader:", cancelError);
                    }
                    return false;
                }

                if (done) {
                    console.log("TTS HTTP stream finished.");
                    break;
                }

                if (!value || value.length === 0) {
                    continue;
                }

                networkChunkNumber++;
                totalBytes += value.length;

                console.log(
                    `HTTP PCM chunk ${networkChunkNumber}:`,
                    value.length,
                    "bytes"
                );

                appendPCMData(value);
                createPCMFrames();

                const bufferedBytes =
                    ttsQueueRef.current.length * PCM_FRAME_SIZE;

                if (
                    !ttsPlaybackStartedRef.current &&
                    bufferedBytes >= INITIAL_BUFFER_SIZE
                ) {
                    ttsPlaybackStartedRef.current = true;
                    setTtsStatus("received");
                    await consumeTTSQueue();
                } else if (ttsPlaybackStartedRef.current) {
                    await consumeTTSQueue();
                }
            }

            // Send the final partial PCM frame without adding artificial silence.
            if (pcmBufferRef.current.length > 0) {
                ttsQueueRef.current.push(pcmBufferRef.current);
                pcmBufferRef.current = new Uint8Array(0);
            }

            if (totalBytes === 0) {
                throw new Error("Cartesia returned an empty audio stream.");
            }

            if (totalBytes % BYTES_PER_SAMPLE !== 0) {
                throw new Error(
                    "Cartesia returned an incomplete PCM16 sample (odd number of bytes)."
                );
            }

            if (!ttsPlaybackStartedRef.current) {
                ttsPlaybackStartedRef.current = true;
                setTtsStatus("received");
            }

            await consumeTTSQueue();

            if (!anamAudioStreamRef.current) {
                throw new Error("Anam audio input stream was closed before TTS completed.");
            }

            // Signal that no more audio chunks belong to this speech sequence.
            await anamAudioStreamRef.current.endSequence();

            console.log("All TTS audio chunks sent to Anam.");

            // The SDK's endSequence() closes the input sequence; it is not a
            // playback-finished callback. Estimate the remaining playback time
            // from the PCM duration and when the first frame was submitted.
            const audioDurationMs =
                (totalBytes / PCM_BYTES_PER_SECOND) * 1000;
            const playbackStartedAt = ttsPlaybackStartedAtRef.current;
            const elapsedSinceFirstSend = playbackStartedAt
                ? Date.now() - playbackStartedAt
                : 0;
            const remainingPlaybackMs = Math.max(
                0,
                audioDurationMs - elapsedSinceFirstSend
            );

            await new Promise((resolve) => {
                setTimeout(
                    resolve,
                    remainingPlaybackMs + PLAYBACK_COMPLETION_PADDING_MS
                );
            });

            // The user may have ended the session while playback was draining.
            if (generationId !== ttsGenerationIdRef.current) {
                return false;
            }

            avatarSpeakingRef.current = false;
            avatarPlaybackActiveRef.current = false;
            setTtsStatus("received");

            console.log("Estimated Anam playback completion.");
            return true;

        } catch (err) {
            console.error("Avatar TTS error:", err);

            if (generationId === ttsGenerationIdRef.current) {
                ttsQueueRef.current = [];
                pcmBufferRef.current = new Uint8Array(0);
                ttsPlaybackStartedRef.current = false;
                ttsPlaybackStartedAtRef.current = null;

                avatarSpeakingRef.current = false;
                avatarPlaybackActiveRef.current = false;

                setTtsStatus("error");
                setError(
                    err?.message || "Failed to make the avatar speak."
                );
            }

            // VAD is restarted in onSpeechEnd's finally block, after the
            // entire request/TTS flow has returned and processingSpeech is reset.
            return false;
        }
    };

    // --------------------------------------------------
    // SEND TRANSCRIPT TO CHAT API
    // --------------------------------------------------

    const sendToChatbot = async (text) => {

        try {

            if (
                !text ||
                !text.trim()
            ) {
                return;
            }

            setChatStatus("thinking");
            setError("");

            console.log(
                "Sending transcript to /api/chat:",
                text
            );

            // ------------------------------------------
            // GET CURRENT SESSION ID
            // ------------------------------------------

            const sessionId =
                localStorage.getItem(
                    "avatar_session_id"
                );

            // ------------------------------------------
            // SEND TO CHAT API
            // ------------------------------------------

            const response = await fetch(
                `${API_URL}/api/chat`,
                {
                    method: "POST",

                    headers: {
                        "Content-Type":
                            "application/json",
                    },

                    body: JSON.stringify({
                        query: text,
                        session_id: sessionId,
                        top_k: 10,
                        score_threshold: 0.0,
                    }),
                }
            );

            if (!response.ok) {

                const errorText =
                    await response.text();

                throw new Error(
                    `Chat API failed: ${errorText}`
                );
            }

            const data =
                await response.json();

            console.log(
                "Chatbot response:",
                data
            );

            // ------------------------------------------
            // SYNC SESSION ID WITH BACKEND
            // ------------------------------------------

            if (data.session_id) {

                localStorage.setItem(
                    "avatar_session_id",
                    data.session_id
                );

                console.log(
                    "Session ID synced:",
                    data.session_id
                );
            }

            // ------------------------------------------
            // GET AI ANSWER
            // ------------------------------------------

            const answer =
                data.answer?.trim();

            if (!answer) {

                throw new Error(
                    "Chatbot returned an empty answer."
                );
            }

            console.log(
                "AI ANSWER:",
                answer
            );

            // ------------------------------------------
            // SHOW ANSWER
            // ------------------------------------------

            setChatAnswer(answer);
            setChatStatus("received");

            // ------------------------------------------
            // SEND TO TTS
            // WAIT FOR AVATAR SPEECH TO FINISH
            // ------------------------------------------

            console.log(
                "Sending AI answer to avatar..."
            );

            const spokeSuccessfully =
                await speakAnswer(answer);

            // ------------------------------------------
            // SHOW LEAD FORM
            // ONLY AFTER AVATAR FINISHES
            // ------------------------------------------

            if (
                data.show_lead_form === true &&
                spokeSuccessfully
            ) {

                console.log(
                    "Avatar playback wait completed. Showing lead form."
                );

                setLeadError("");
                leadFormActiveRef.current = true;
                setShowLeadForm(true);
            }

        } catch (err) {

            console.error(
                "Chatbot error:",
                err
            );

            setChatStatus("error");

            setError(
                err?.message ||
                "Failed to get chatbot response."
            );
        }
    };

    // --------------------------------------------------
    // LEAD FORM INPUT HANDLER
    // --------------------------------------------------

    const handleLeadInputChange = (event) => {

        const {
            name,
            value
        } = event.target;

        setLeadForm((previous) => ({
            ...previous,
            [name]: value,
        }));

        setLeadError("");
    };

    // --------------------------------------------------
    // SUBMIT LEAD FORM
    // --------------------------------------------------

    const submitLeadForm = async (event) => {

        event.preventDefault();

        setLeadError("");

        const name =
            leadForm.name.trim();

        const email =
            leadForm.email.trim();

        const phone =
            leadForm.phone.trim();

        // ------------------------------------------
        // FRONTEND VALIDATION
        // ------------------------------------------

        if (!name) {
            setLeadError(
                "Please enter your name."
            );
            return;
        }

        if (!email) {
            setLeadError(
                "Please enter your email."
            );
            return;
        }

        if (!phone) {
            setLeadError(
                "Please enter your phone number."
            );
            return;
        }

        // ------------------------------------------
        // GET CURRENT SESSION
        // ------------------------------------------

        const sessionId =
            localStorage.getItem(
                "avatar_session_id"
            );

        if (!sessionId) {

            setLeadError(
                "Session not found. Please restart the conversation."
            );

            return;
        }

        try {

            setLeadSubmitting(true);

            console.log(
                "Submitting lead..."
            );

            const response = await fetch(
                `${API_URL}/api/leads`,
                {
                    method: "POST",

                    headers: {
                        "Content-Type":
                            "application/json",
                    },

                    body: JSON.stringify({
                        session_id: sessionId,
                        name: name,
                        email: email,
                        phone: phone,
                    }),
                }
            );

            if (!response.ok) {

                const errorText =
                    await response.text();

                console.error(
                    "Lead API error:",
                    errorText
                );

                throw new Error(
                    "Failed to submit your details."
                );
            }

            const data =
                await response.json();

            console.log(
                "Lead created:",
                data
            );

            // ------------------------------------------
            // SUCCESS
            // ------------------------------------------

            setLeadSubmitted(true);

            setLeadForm({
                name: "",
                email: "",
                phone: "",
            });

            // Close after a short delay
            setTimeout(async () => {
                setShowLeadForm(false);
                setLeadSubmitted(false);
                leadFormActiveRef.current = false;

                if (
                    conversationActiveRef.current &&
                    !avatarSpeakingRef.current
                ) {
                    await startVAD();
                }
            }, 2000);

        } catch (err) {

            console.error(
                "Lead submission error:",
                err
            );

            setLeadError(
                err?.message ||
                "Failed to submit your details."
            );

        } finally {

            setLeadSubmitting(false);
        }
    };

    // --------------------------------------------------
    // SEND AUDIO TO WHISPER
    // --------------------------------------------------

    const sendAudioToWhisper = async (audioBlob) => {

        try {

            setChatStatus("transcribing");
            setError("");

            console.log(
                "Sending audio to Whisper..."
            );

            const formData =
                new FormData();

            formData.append(
                "audio",
                audioBlob,
                "speech.wav"
            );

            const response = await fetch(
                `${API_URL}/api/stt`,
                {
                    method: "POST",
                    body: formData,
                }
            );

            if (!response.ok) {

                const errorText =
                    await response.text();

                throw new Error(
                    `STT failed: ${errorText}`
                );
            }

            const data =
                await response.json();

            console.log(
                "Whisper response:",
                data
            );

            const text =
                data.text?.trim();

            if (!text) {

                setChatStatus("idle");

                setError(
                    "I couldn't detect any speech. Please try again."
                );

                return;
            }

            console.log(
                "Final Whisper transcript:",
                text
            );

            setTranscript(text);

            await sendToChatbot(text);

        } catch (err) {

            console.error(
                "Whisper error:",
                err
            );

            setChatStatus("error");

            setError(
                err?.message ||
                "Speech transcription failed."
            );
        }
    };


    // --------------------------------------------------
    // STATUS TEXT
    // --------------------------------------------------

    const getStatusText = () => {

        switch (status) {

            case "connecting":
                return "Connecting...";

            case "connected":
                return "Online";

            case "error":
                return "Connection failed";

            default:
                return "Ready";
        }
    };

    // --------------------------------------------------
    // UI
    // --------------------------------------------------

    return (
        <div style={styles.page}>

            <div style={styles.card}>

                {/* HEADER */}

                <div style={styles.header}>

                    <h1 style={styles.title}>
                        Webenza AI Assistant
                    </h1>

                    <div
                        style={
                            styles.statusRow
                        }
                    >

                        <span
                            style={{
                                ...styles.statusDot,

                                background:
                                    status ===
                                    "connected"
                                        ? "#22c55e"
                                        : status ===
                                          "connecting"
                                        ? "#f59e0b"
                                        : status ===
                                          "error"
                                        ? "#ef4444"
                                        : "#6b7280",
                            }}
                        />

                        <span
                            style={
                                styles.statusText
                            }
                        >
                            {getStatusText()}
                        </span>

                    </div>

                </div>

                {/* AVATAR */}

                <div
                    style={
                        styles.avatarContainer
                    }
                >

                <video
                    id="anam-avatar-video"
                    ref={videoRef}
                    autoPlay
                    playsInline
                    muted={false}
                    style={styles.video}
                />

                    {status !==
                        "connected" && (

                        <div
                            style={
                                styles.avatarOverlay
                            }
                        >

                            <div
                                style={
                                    styles.avatarIcon
                                }
                            >
                                👤
                            </div>

                            <p
                                style={
                                    styles.overlayText
                                }
                            >
                                {status ===
                                "connecting"
                                    ? "Connecting to your AI assistant..."
                                    : "Your AI assistant is ready"}
                            </p>

                        </div>

                    )}

                </div>

                {/* ANAM AUDIO INPUT */}


                {/* DESCRIPTION */}

                <div
                    style={
                        styles.description
                    }
                >

                    <h2
                        style={
                            styles.welcome
                        }
                    >
                        Hi, I'm your AI assistant
                    </h2>

                    <p
                        style={
                            styles.subtitle
                        }
                    >
                        Ask me anything about
                        Webenza's services.
                    </p>

                </div>

                {/* AVATAR CONTROLS */}

                <div
                    style={styles.controls}
                >

                    {status ===
                    "connected" ? (

                        <button
                            onClick={
                                stopAvatar
                            }
                            style={
                                styles.secondaryButton
                            }
                        >
                            End Conversation
                        </button>

                    ) : (

                        <button
                            onClick={
                                startAvatar
                            }
                            style={
                                styles.primaryButton
                            }
                            disabled={
                                status ===
                                "connecting"
                            }
                        >
                            ▶{" "}
                            {status ===
                            "connecting"
                                ? "Connecting..."
                                : "Start Conversation"}
                        </button>

                    )}

                </div>

                {/* MICROPHONE */}

                <div
                    style={
                        styles.voiceInputSection
                    }
                >


                    {/*
                    {transcript && (

                        <div
                            style={
                                styles.transcriptBox
                            }
                        >

                            <span
                                style={
                                    styles.label
                                }
                            >
                                You:
                            </span>

                            <p
                                style={
                                    styles.transcript
                                }
                            >
                                {transcript}
                            </p>

                        </div>

                    )}
                    */}

                </div>

                {/* CHAT STATUS */}

               

                

                {/* TTS STATUS */}

               


                {/* CHAT ANSWER */}

                {/*
                {chatAnswer && (

                    <div
                        style={
                            styles.answerBox
                        }
                    >

                        <span
                            style={
                                styles.label
                            }
                        >
                            Assistant:
                        </span>

                        <p
                            style={
                                styles.answer
                            }
                        >
                            {chatAnswer}
                        </p>

                    </div>

                )}*/}

                {/* ERROR */}

                {error && (

                    <p
                        style={
                            styles.error
                        }
                    >
                        {error}
                    </p>

                )}

            </div>

            {/* ==================================================
                LEAD FORM POPUP
            ================================================== */}

            {showLeadForm && (

                <div style={styles.modalOverlay}>

                    <div
                        style={styles.modal}
                    >

                        {!leadSubmitted ? (

                            <>

                                <div
                                    style={
                                        styles.modalHeader
                                    }
                                >

                                    <h2
                                        style={
                                            styles.modalTitle
                                        }
                                    >
                                        Let's stay connected
                                    </h2>

                                    <p
                                        style={
                                            styles.modalSubtitle
                                        }
                                    >
                                        Please share your details
                                        and our team will get in
                                        touch with you.
                                    </p>

                                </div>

                                <form
                                    onSubmit={
                                        submitLeadForm
                                    }
                                >

                                    {/* NAME */}

                                    <div
                                        style={
                                            styles.formGroup
                                        }
                                    >

                                        <label
                                            style={
                                                styles.formLabel
                                            }
                                        >
                                            Name
                                        </label>

                                        <input
                                            type="text"
                                            name="name"
                                            value={
                                                leadForm.name
                                            }
                                            onChange={
                                                handleLeadInputChange
                                            }
                                            placeholder="Enter your name"
                                            style={
                                                styles.formInput
                                            }
                                            disabled={
                                                leadSubmitting
                                            }
                                        />

                                    </div>

                                    {/* EMAIL */}

                                    <div
                                        style={
                                            styles.formGroup
                                        }
                                    >

                                        <label
                                            style={
                                                styles.formLabel
                                            }
                                        >
                                            Email
                                        </label>

                                        <input
                                            type="email"
                                            name="email"
                                            value={
                                                leadForm.email
                                            }
                                            onChange={
                                                handleLeadInputChange
                                            }
                                            placeholder="Enter your email"
                                            style={
                                                styles.formInput
                                            }
                                            disabled={
                                                leadSubmitting
                                            }
                                        />

                                    </div>

                                    {/* PHONE */}

                                    <div
                                        style={
                                            styles.formGroup
                                        }
                                    >

                                        <label
                                            style={
                                                styles.formLabel
                                            }
                                        >
                                            Phone
                                        </label>

                                        <input
                                            type="tel"
                                            name="phone"
                                            value={
                                                leadForm.phone
                                            }
                                            onChange={
                                                handleLeadInputChange
                                            }
                                            placeholder="Enter your phone number"
                                            style={
                                                styles.formInput
                                            }
                                            disabled={
                                                leadSubmitting
                                            }
                                        />

                                    </div>

                                    {/* FORM ERROR */}

                                    {leadError && (

                                        <p
                                            style={
                                                styles.leadFormError
                                            }
                                        >
                                            {leadError}
                                        </p>

                                    )}

                                    {/* SUBMIT */}

                                    <button
                                        type="submit"
                                        style={
                                            styles.submitLeadButton
                                        }
                                        disabled={
                                            leadSubmitting
                                        }
                                    >

                                        {leadSubmitting
                                            ? "Submitting..."
                                            : "Submit"}

                                    </button>

                                </form>

                            </>

                        ) : (

                            <div
                                style={
                                    styles.successContainer
                                }
                            >

                                <div
                                    style={
                                        styles.successIcon
                                    }
                                >
                                    ✓
                                </div>

                                <h2
                                    style={
                                        styles.modalTitle
                                    }
                                >
                                    Thank you!
                                </h2>

                                <p
                                    style={
                                        styles.modalSubtitle
                                    }
                                >
                                    Your details have been
                                    submitted successfully.
                                </p>

                            </div>

                        )}

                    </div>

                </div>

            )}

        </div>
    );
}

// --------------------------------------------------
// STYLES
// --------------------------------------------------

const styles = {

    page: {
        minHeight: "100vh",
        background: "#0f1117",
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        padding: "40px 20px",
        boxSizing: "border-box",
        fontFamily:
            "Inter, system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
        position: "relative",
    },

    card: {
        width: "100%",
        maxWidth: "620px",
        background: "#181b23",
        border: "1px solid #2a2e39",
        borderRadius: "20px",
        padding: "28px",
        boxSizing: "border-box",
        boxShadow:
            "0 20px 60px rgba(0, 0, 0, 0.35)",
    },

    header: {
        marginBottom: "22px",
    },

    title: {
        margin: 0,
        color: "#ffffff",
        fontSize: "24px",
        fontWeight: 600,
    },

    statusRow: {
        display: "flex",
        alignItems: "center",
        gap: "8px",
        marginTop: "8px",
    },

    statusDot: {
        width: "8px",
        height: "8px",
        borderRadius: "50%",
        display: "inline-block",
    },

    statusText: {
        color: "#9ca3af",
        fontSize: "14px",
    },

    avatarContainer: {
        position: "relative",
        width: "100%",
        aspectRatio: "16 / 10",
        background: "#0b0d12",
        borderRadius: "16px",
        overflow: "hidden",
    },

    video: {
        width: "100%",
        height: "100%",
        objectFit: "cover",
        display: "block",
    },

    avatarOverlay: {
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        alignItems: "center",
        background:
            "rgba(11, 13, 18, 0.65)",
    },

    avatarIcon: {
        width: "64px",
        height: "64px",
        borderRadius: "50%",
        background: "#252936",
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        fontSize: "28px",
        marginBottom: "12px",
    },

    overlayText: {
        color: "#d1d5db",
        fontSize: "14px",
        margin: 0,
    },

    description: {
        textAlign: "center",
        marginTop: "24px",
    },

    welcome: {
        color: "#ffffff",
        fontSize: "20px",
        fontWeight: 500,
        margin: 0,
    },

    subtitle: {
        color: "#9ca3af",
        fontSize: "14px",
        marginTop: "8px",
    },

    controls: {
        display: "flex",
        justifyContent: "center",
        marginTop: "22px",
    },

    primaryButton: {
        border: "none",
        borderRadius: "10px",
        padding: "12px 24px",
        background: "#ffffff",
        color: "#111318",
        fontSize: "14px",
        fontWeight: 600,
        cursor: "pointer",
    },

    secondaryButton: {
        border: "1px solid #3a3f4b",
        borderRadius: "10px",
        padding: "12px 24px",
        background: "transparent",
        color: "#d1d5db",
        fontSize: "14px",
        fontWeight: 500,
        cursor: "pointer",
    },

    voiceInputSection: {
        marginTop: "24px",
        textAlign: "center",
    },


    listeningText: {
        color: "#f59e0b",
        fontSize: "13px",
        marginTop: "10px",
    },

    transcriptBox: {
        marginTop: "14px",
        padding: "12px 14px",
        background: "#222631",
        borderRadius: "10px",
        textAlign: "left",
    },

    label: {
        color: "#9ca3af",
        fontSize: "12px",
        fontWeight: 600,
    },

    transcript: {
        color: "#ffffff",
        fontSize: "14px",
        lineHeight: 1.5,
        margin: "5px 0 0",
    },

    thinkingText: {
        textAlign: "center",
        color: "#f59e0b",
        fontSize: "13px",
        marginTop: "15px",
    },

    speakingText: {
        textAlign: "center",
        color: "#60a5fa",
        fontSize: "13px",
        marginTop: "15px",
    },

    answerBox: {
        marginTop: "15px",
        padding: "14px",
        background: "#222631",
        borderRadius: "10px",
        textAlign: "left",
    },

    answer: {
        color: "#ffffff",
        fontSize: "14px",
        lineHeight: 1.6,
        margin: "5px 0 0",
    },

    successText: {
        textAlign: "center",
        color: "#22c55e",
        fontSize: "13px",
        marginTop: "15px",
    },

    error: {
        textAlign: "center",
        color: "#f87171",
        fontSize: "13px",
        marginTop: "16px",
    },

    // ==================================================
    // LEAD MODAL
    // ==================================================

    modalOverlay: {
        position: "fixed",
        inset: 0,
        background:
            "rgba(0, 0, 0, 0.70)",
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        padding: "20px",
        boxSizing: "border-box",
        zIndex: 1000,
    },

    modal: {
        width: "100%",
        maxWidth: "440px",
        background: "#181b23",
        border: "1px solid #343946",
        borderRadius: "18px",
        padding: "28px",
        boxSizing: "border-box",
        boxShadow:
            "0 25px 80px rgba(0, 0, 0, 0.55)",
    },

    modalHeader: {
        marginBottom: "22px",
    },

    modalTitle: {
        margin: 0,
        color: "#ffffff",
        fontSize: "22px",
        fontWeight: 600,
    },

    modalSubtitle: {
        margin: "8px 0 0",
        color: "#9ca3af",
        fontSize: "14px",
        lineHeight: 1.5,
    },

    formGroup: {
        marginBottom: "16px",
    },

    formLabel: {
        display: "block",
        color: "#d1d5db",
        fontSize: "13px",
        fontWeight: 500,
        marginBottom: "7px",
    },

    formInput: {
        width: "100%",
        boxSizing: "border-box",
        padding: "12px 13px",
        borderRadius: "9px",
        border: "1px solid #3a3f4b",
        background: "#222631",
        color: "#ffffff",
        fontSize: "14px",
        outline: "none",
    },

    leadFormError: {
        color: "#f87171",
        fontSize: "13px",
        margin: "4px 0 14px",
    },

    submitLeadButton: {
        width: "100%",
        border: "none",
        borderRadius: "9px",
        padding: "12px",
        background: "#ffffff",
        color: "#111318",
        fontSize: "14px",
        fontWeight: 600,
        cursor: "pointer",
        marginTop: "4px",
    },

    successContainer: {
        textAlign: "center",
        padding: "15px 0",
    },

    successIcon: {
        width: "56px",
        height: "56px",
        margin: "0 auto 16px",
        borderRadius: "50%",
        background: "#22c55e",
        color: "#ffffff",
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        fontSize: "28px",
        fontWeight: 700,
    },
};

export default AvatarWidget;