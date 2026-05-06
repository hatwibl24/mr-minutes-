// ============================================================
//  MR. MINUTES — ElevenLabs Voice System
// ============================================================

const ELEVEN_API_KEY = "sk_e81e58bfb2f46c842c8addc60e9cef9c72bf94f8d9911055";
const VOICE_ID       = "xgkclGgJ3fuNoVIAZtCi";

let isPlaying = false;

async function elevenSpeak(text, onDone = null) {
  try {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`,
      {
        method: "POST",
        headers: {
          "xi-api-key": ELEVEN_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text,
          model_id: "eleven_monolingual_v1",
          voice_settings: {
            stability: 0.4,
            similarity_boost: 0.85,
            style: 0.3,
            use_speaker_boost: true,
          },
        }),
      }
    );

    if (!response.ok) {
      console.warn("ElevenLabs error — falling back to browser TTS");
      browserSpeak(text, onDone);
      return;
    }

    const blob  = await response.blob();
    const url   = URL.createObjectURL(blob);
    const audio = new Audio(url);

    audio.onended = () => {
      URL.revokeObjectURL(url);
      isPlaying = false;
      if (onDone) onDone();
    };

    audio.onerror = () => {
      browserSpeak(text, onDone);
    };

    isPlaying = true;
    audio.play();

  } catch (err) {
    console.warn("ElevenLabs failed — falling back", err);
    browserSpeak(text, onDone);
  }
}

function browserSpeak(text, onDone = null) {
  const synth = window.speechSynthesis;
  synth.cancel();
  const utt  = new SpeechSynthesisUtterance(text);
  utt.rate   = 0.95;
  utt.pitch  = 1.1;
  utt.volume = 1;
  if (onDone) utt.onend = onDone;
  synth.speak(utt);
}