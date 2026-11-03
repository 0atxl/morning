// Construct during the recording gesture so browsers can unlock Web Audio.
// The analyser taps the recorder's stream and never connects to the speakers.
export function micLevelMeter(onLevel: (level: number) => void) {
  const context = new AudioContext();
  void context.resume().catch(() => {});
  let frame = 0;
  return {
    listen(stream: MediaStream) {
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      context.createMediaStreamSource(stream).connect(analyser);
      const samples = new Float32Array(analyser.fftSize);
      let level = 0;
      let last = performance.now();
      const sample = (now: number) => {
        analyser.getFloatTimeDomainData(samples);
        let energy = 0;
        for (const value of samples) energy += value * value;
        const rms = Math.sqrt(energy / samples.length);
        const target = Math.min(1, Math.sqrt(Math.max(0, rms - 0.006) * 7));
        const decay = target > level ? 45 : 210;
        level += (target - level) * (1 - Math.exp(-(now - last) / decay));
        last = now;
        onLevel(level);
        frame = requestAnimationFrame(sample);
      };
      frame = requestAnimationFrame(sample);
    },
    close() {
      cancelAnimationFrame(frame);
      onLevel(0);
      void context.close().catch(() => {});
    },
  };
}
