
// Utilitaire pour encoder un AudioBuffer en WAV Blob
// Nécessaire pour la sauvegarde du projet

function writeString(view: DataView, offset: number, string: string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}

function floatTo16BitPCM(output: DataView, offset: number, input: Float32Array) {
  for (let i = 0; i < input.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, input[i]));
    output.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }
}

export const audioBufferToWav = (buffer: AudioBuffer): Blob => {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const format = 1; // PCM
  const bitDepth = 16;
  
  // Entrelacement des canaux si stéréo
  let data: Float32Array;
  if (numChannels === 2) {
      const left = buffer.getChannelData(0);
      const right = buffer.getChannelData(1);
      data = new Float32Array(left.length * 2);
      for (let i = 0; i < left.length; i++) {
          data[i * 2] = left[i];
          data[i * 2 + 1] = right[i];
      }
  } else {
      data = buffer.getChannelData(0);
  }

  const bytesPerSample = bitDepth / 8;
  const blockAlign = numChannels * bytesPerSample;
  const bufferLength = 44 + data.length * bytesPerSample;
  const arrayBuffer = new ArrayBuffer(bufferLength);
  const view = new DataView(arrayBuffer);

  // RIFF Chunk
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + data.length * bytesPerSample, true);
  writeString(view, 8, 'WAVE');

  // fmt Chunk
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, format, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);

  // data Chunk
  writeString(view, 36, 'data');
  view.setUint32(40, data.length * bytesPerSample, true);
  
  floatTo16BitPCM(view, 44, data);

  return new Blob([view], { type: 'audio/wav' });
};
