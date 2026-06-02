const $ = (selector) => document.querySelector(selector);

const els = {
  dropZone: $("#dropZone"),
  fileInput: $("#fileInput"),
  selectButton: $("#selectButton"),
  audioPlayer: $("#audioPlayer"),
  statusText: $("#statusText"),
  heroCanvas: $("#heroCanvas"),
  waveformCanvas: $("#waveformCanvas"),
  spectrumCanvas: $("#spectrumCanvas"),
  spectrogramCanvas: $("#spectrogramCanvas"),
  loudnessCanvas: $("#loudnessCanvas"),
  chromaCanvas: $("#chromaCanvas"),
  stereoCanvas: $("#stereoCanvas"),
  durationValue: $("#durationValue"),
  bpmValue: $("#bpmValue"),
  keyValue: $("#keyValue"),
  rmsValue: $("#rmsValue"),
  peakValue: $("#peakValue"),
  brightnessValue: $("#brightnessValue"),
  waveformMeta: $("#waveformMeta"),
  keyConfidence: $("#keyConfidence"),
  loudnessMeta: $("#loudnessMeta"),
  stereoMeta: $("#stereoMeta"),
  profileTitle: $("#profileTitle"),
  profileText: $("#profileText"),
  tagRow: $("#tagRow"),
  fileNameValue: $("#fileNameValue"),
  fileDetails: $("#fileDetails"),
  mixDetails: $("#mixDetails"),
  bandList: $("#bandList"),
  exportButton: $("#exportButton"),
  clearButton: $("#clearButton"),
};

const colors = {
  bg: "#172128",
  grid: "rgba(255,255,255,0.08)",
  ink: "#fffdfa",
  muted: "rgba(255,255,255,0.56)",
  teal: "#40c4b8",
  coral: "#ff735d",
  amber: "#f0b23e",
  blue: "#74a7ff",
  green: "#6fd08c",
};

const pitchNames = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const majorProfile = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const minorProfile = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

let audioContext;
let visualContext;
let mediaSource;
let analyser;
let animationId;
let objectUrl;
let latestReport = null;

drawIdle();
bindEvents();

function bindEvents() {
  els.selectButton.addEventListener("click", () => els.fileInput.click());
  els.dropZone.addEventListener("click", (event) => {
    if (event.target === els.dropZone) els.fileInput.click();
  });

  els.fileInput.addEventListener("change", (event) => {
    const file = event.target.files?.[0];
    if (file) handleFile(file);
  });

  ["dragenter", "dragover"].forEach((type) => {
    els.dropZone.addEventListener(type, (event) => {
      event.preventDefault();
      els.dropZone.classList.add("dragging");
    });
  });

  ["dragleave", "drop"].forEach((type) => {
    els.dropZone.addEventListener(type, (event) => {
      event.preventDefault();
      els.dropZone.classList.remove("dragging");
    });
  });

  els.dropZone.addEventListener("drop", (event) => {
    const file = event.dataTransfer.files?.[0];
    if (file) handleFile(file);
  });

  els.audioPlayer.addEventListener("play", async () => {
    await ensureVisualizer();
    animateHero();
  });

  els.audioPlayer.addEventListener("pause", () => {
    if (latestReport) drawHeroStatic(latestReport);
  });

  els.exportButton.addEventListener("click", exportReport);
  els.clearButton.addEventListener("click", resetApp);
}

async function handleFile(file) {
  // 파일 선택 이후의 브라우저 전용 처리를 모두 담당한다.
  // Object URL 생성, 오디오 디코딩, 분석 중 상태 표시, 실패 메시지를 이 함수에서 순서대로 처리한다.
  if (!file.type.startsWith("audio/") && !file.name.match(/\.(mp3|wav|ogg|flac|m4a|aac)$/i)) {
    setStatus("오디오 파일만 가능");
    return;
  }

  resetAudioUrl();
  setStatus("파일 읽는 중");
  els.fileNameValue.textContent = file.name;
  els.exportButton.disabled = true;
  els.clearButton.disabled = false;

  objectUrl = URL.createObjectURL(file);
  els.audioPlayer.src = objectUrl;
  els.audioPlayer.load();

  try {
    if (!audioContext) audioContext = new AudioContext();
    const arrayBuffer = await file.arrayBuffer();
    setStatus("디코딩 중");
    const decoded = await audioContext.decodeAudioData(arrayBuffer.slice(0));
    setStatus("분석 중");
    latestReport = await analyzeAudio(decoded, file);
    renderReport(latestReport);
    setStatus("분석 완료");
    els.exportButton.disabled = false;
  } catch (error) {
    console.error(error);
    setStatus("분석 실패");
    els.profileTitle.textContent = "파일을 분석할 수 없습니다";
    els.profileText.textContent = "브라우저에서 지원하지 않는 형식이거나 파일이 손상되었을 수 있습니다.";
  }
}

async function analyzeAudio(buffer, file) {
  // 디코딩된 AudioBuffer에서 한 번에 분석 리포트를 만든다.
  // 파형, 라우드니스, 스펙트럼, BPM, 스테레오 분석 결과를 같은 데이터 묶음으로 반환해 화면 전체가 같은 기준을 쓰게 한다.
  const mono = makeMono(buffer);
  await nextFrame();

  const basics = analyzeBasics(buffer, mono, file);
  setStatus("파형 계산 중");
  const waveform = buildWaveform(mono, 900);
  const loudness = buildLoudness(mono, buffer.sampleRate, 260);
  await nextFrame();

  setStatus("스펙트럼 계산 중");
  const spectral = analyzeSpectrum(mono, buffer.sampleRate);
  await nextFrame();

  setStatus("템포 계산 중");
  const tempo = estimateTempo(mono, buffer.sampleRate);
  await nextFrame();

  setStatus("스테레오 계산 중");
  const stereo = analyzeStereo(buffer);

  return {
    file: {
      name: file.name,
      type: file.type || "unknown",
      size: file.size,
      estimatedBitrate: buffer.duration ? (file.size * 8) / buffer.duration / 1000 : 0,
    },
    basics,
    waveform,
    loudness,
    spectral,
    tempo,
    stereo,
    profile: makeProfile(basics, spectral, tempo, stereo),
  };
}

function makeMono(buffer) {
  const length = buffer.length;
  const channels = buffer.numberOfChannels;
  const mono = new Float32Array(length);

  for (let channel = 0; channel < channels; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < length; i += 1) {
      mono[i] += data[i] / channels;
    }
  }

  return mono;
}

function analyzeBasics(buffer, mono, file) {
  const step = Math.max(1, Math.floor(mono.length / 2200000));
  let sumSquares = 0;
  let sum = 0;
  let peak = 0;
  let clipping = 0;
  let silence = 0;
  let zeroCrossings = 0;
  let count = 0;
  let previous = mono[0] || 0;

  for (let i = 0; i < mono.length; i += step) {
    const sample = mono[i];
    const abs = Math.abs(sample);
    peak = Math.max(peak, abs);
    sumSquares += sample * sample;
    sum += sample;
    if (abs >= 0.999) clipping += 1;
    if (abs < 0.001) silence += 1;
    if ((previous >= 0 && sample < 0) || (previous < 0 && sample >= 0)) zeroCrossings += 1;
    previous = sample;
    count += 1;
  }

  const rms = Math.sqrt(sumSquares / Math.max(1, count));
  return {
    duration: buffer.duration,
    sampleRate: buffer.sampleRate,
    channels: buffer.numberOfChannels,
    fileType: file.type || "unknown",
    rms,
    rmsDb: toDb(rms),
    peak,
    peakDb: toDb(peak),
    crestDb: toDb(peak / Math.max(rms, 1e-9)),
    dcOffset: sum / Math.max(1, count),
    clippingPercent: (clipping / Math.max(1, count)) * 100,
    silencePercent: (silence / Math.max(1, count)) * 100,
    zeroCrossingRate: zeroCrossings / Math.max(1, count),
  };
}

function buildWaveform(mono, bins) {
  const result = [];
  const block = Math.max(1, Math.floor(mono.length / bins));

  for (let i = 0; i < bins; i += 1) {
    const start = i * block;
    const end = Math.min(mono.length, start + block);
    let min = 1;
    let max = -1;
    let sumSquares = 0;

    for (let j = start; j < end; j += 1) {
      const sample = mono[j];
      min = Math.min(min, sample);
      max = Math.max(max, sample);
      sumSquares += sample * sample;
    }

    result.push({
      min,
      max,
      rms: Math.sqrt(sumSquares / Math.max(1, end - start)),
    });
  }

  return result;
}

function buildLoudness(mono, sampleRate, bins) {
  const result = [];
  const block = Math.max(256, Math.floor(mono.length / bins));

  for (let i = 0; i < bins; i += 1) {
    const start = i * block;
    const end = Math.min(mono.length, start + block);
    let sumSquares = 0;
    let peak = 0;

    for (let j = start; j < end; j += 1) {
      const sample = mono[j];
      peak = Math.max(peak, Math.abs(sample));
      sumSquares += sample * sample;
    }

    result.push({
      time: start / sampleRate,
      rmsDb: toDb(Math.sqrt(sumSquares / Math.max(1, end - start))),
      peakDb: toDb(peak),
    });
  }

  return result;
}

function analyzeSpectrum(mono, sampleRate) {
  // 곡 전체에서 여러 프레임을 샘플링해 평균 스펙트럼과 음색 지표를 계산한다.
  // 한 순간만 보면 인트로나 무음 구간에 치우칠 수 있어서, 여러 지점을 섞어 안정적인 믹스 특징을 얻는다.
  const fftSize = 4096;
  const half = fftSize / 2;
  const frameCount = Math.min(72, Math.max(10, Math.floor(mono.length / fftSize)));
  const hop = Math.max(fftSize, Math.floor((mono.length - fftSize) / Math.max(1, frameCount - 1)));
  const averageMag = new Float32Array(half);
  const chroma = new Float32Array(12);
  const bandEnergy = {
    sub: 0,
    bass: 0,
    lowMid: 0,
    mid: 0,
    highMid: 0,
    air: 0,
  };
  let centroidSum = 0;
  let rolloffSum = 0;
  let bandwidthSum = 0;
  let flatnessSum = 0;
  let usedFrames = 0;

  for (let frame = 0; frame < frameCount; frame += 1) {
    const start = Math.min(mono.length - fftSize, frame * hop);
    if (start < 0) break;

    const real = new Float32Array(fftSize);
    const imag = new Float32Array(fftSize);
    for (let i = 0; i < fftSize; i += 1) {
      const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (fftSize - 1));
      real[i] = (mono[start + i] || 0) * window;
    }

    fft(real, imag);

    let total = 0;
    let weighted = 0;
    let logSum = 0;
    const mags = new Float32Array(half);

    for (let bin = 1; bin < half; bin += 1) {
      const mag = Math.hypot(real[bin], imag[bin]);
      const freq = (bin * sampleRate) / fftSize;
      mags[bin] = mag;
      averageMag[bin] += mag;
      total += mag;
      weighted += freq * mag;
      logSum += Math.log(mag + 1e-12);
      addToBand(bandEnergy, freq, mag * mag);

      if (freq >= 40 && freq <= 5000) {
        const midi = Math.round(69 + 12 * Math.log2(freq / 440));
        const pc = ((midi % 12) + 12) % 12;
        chroma[pc] += mag;
      }
    }

    if (total <= 0) continue;
    const centroid = weighted / total;
    let roll = 0;
    let cumulative = 0;
    const target = total * 0.85;
    for (let bin = 1; bin < half; bin += 1) {
      cumulative += mags[bin];
      if (cumulative >= target) {
        roll = (bin * sampleRate) / fftSize;
        break;
      }
    }

    let variance = 0;
    for (let bin = 1; bin < half; bin += 1) {
      const freq = (bin * sampleRate) / fftSize;
      variance += (freq - centroid) ** 2 * mags[bin];
    }

    centroidSum += centroid;
    rolloffSum += roll;
    bandwidthSum += Math.sqrt(variance / total);
    flatnessSum += Math.exp(logSum / (half - 1)) / (total / (half - 1));
    usedFrames += 1;
  }

  if (usedFrames > 0) {
    for (let i = 0; i < half; i += 1) averageMag[i] /= usedFrames;
  }

  const totalBand = Object.values(bandEnergy).reduce((sum, value) => sum + value, 0) || 1;
  const bands = Object.fromEntries(
    Object.entries(bandEnergy).map(([key, value]) => [key, value / totalBand])
  );
  const key = estimateKey(chroma);
  const spectrogram = buildSpectrogram(mono, sampleRate);

  return {
    averageMag: Array.from(averageMag),
    fftSize,
    sampleRate,
    centroid: centroidSum / Math.max(1, usedFrames),
    rolloff: rolloffSum / Math.max(1, usedFrames),
    bandwidth: bandwidthSum / Math.max(1, usedFrames),
    flatness: flatnessSum / Math.max(1, usedFrames),
    brightness: (bands.highMid + bands.air) / Math.max(0.0001, bands.sub + bands.bass + bands.lowMid + bands.mid),
    bands,
    chroma: Array.from(normalizeArray(chroma)),
    key,
    spectrogram,
  };
}

function addToBand(target, freq, energy) {
  if (freq < 60) target.sub += energy;
  else if (freq < 250) target.bass += energy;
  else if (freq < 500) target.lowMid += energy;
  else if (freq < 2000) target.mid += energy;
  else if (freq < 6000) target.highMid += energy;
  else target.air += energy;
}

function buildSpectrogram(mono, sampleRate) {
  const fftSize = 1024;
  const half = fftSize / 2;
  const columns = 220;
  const rows = 96;
  const hop = Math.max(fftSize, Math.floor((mono.length - fftSize) / Math.max(1, columns - 1)));
  const data = [];
  let maxValue = 1e-9;

  for (let col = 0; col < columns; col += 1) {
    const start = Math.min(Math.max(0, mono.length - fftSize), col * hop);
    const real = new Float32Array(fftSize);
    const imag = new Float32Array(fftSize);

    for (let i = 0; i < fftSize; i += 1) {
      const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (fftSize - 1));
      real[i] = (mono[start + i] || 0) * window;
    }

    fft(real, imag);
    const column = new Float32Array(rows);

    for (let bin = 1; bin < half; bin += 1) {
      const freq = (bin * sampleRate) / fftSize;
      if (freq < 30) continue;
      const normalized = Math.log(freq / 30) / Math.log((sampleRate / 2) / 30);
      const row = Math.min(rows - 1, Math.max(0, Math.floor(normalized * rows)));
      const mag = Math.hypot(real[bin], imag[bin]);
      column[row] += mag;
      maxValue = Math.max(maxValue, column[row]);
    }

    data.push(Array.from(column));
  }

  return { data, maxValue, rows, columns };
}

function estimateTempo(mono, sampleRate) {
  // 에너지 변화량을 onset으로 보고 자기상관을 돌려 BPM 후보를 찾는다.
  // 외부 라이브러리 없이 빠르게 동작해야 하는 브라우저 앱이므로 정확도보다 반응성과 가벼움을 우선한다.
  const hop = 1024;
  const frameSize = 2048;
  const frameCount = Math.max(0, Math.floor((mono.length - frameSize) / hop));
  if (frameCount < 12) return { bpm: 0, confidence: 0 };

  const energy = new Float32Array(frameCount);
  for (let frame = 0; frame < frameCount; frame += 1) {
    const start = frame * hop;
    let sum = 0;
    for (let i = 0; i < frameSize; i += 1) {
      const sample = mono[start + i];
      sum += sample * sample;
    }
    energy[frame] = Math.sqrt(sum / frameSize);
  }

  const onset = new Float32Array(frameCount);
  let onsetMax = 0;
  for (let i = 1; i < frameCount; i += 1) {
    onset[i] = Math.max(0, energy[i] - energy[i - 1]);
    onsetMax = Math.max(onsetMax, onset[i]);
  }

  if (onsetMax <= 0) return { bpm: 0, confidence: 0 };

  for (let i = 0; i < frameCount; i += 1) onset[i] /= onsetMax;

  const framesPerSecond = sampleRate / hop;
  const minBpm = 55;
  const maxBpm = 190;
  const minLag = Math.floor((framesPerSecond * 60) / maxBpm);
  const maxLag = Math.ceil((framesPerSecond * 60) / minBpm);
  let bestLag = 0;
  let bestScore = 0;
  let scoreSum = 0;

  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let score = 0;
    for (let i = lag; i < frameCount; i += 1) {
      score += onset[i] * onset[i - lag];
    }
    score /= Math.max(1, frameCount - lag);
    scoreSum += score;
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }

  if (!bestLag) return { bpm: 0, confidence: 0 };
  let bpm = (60 * framesPerSecond) / bestLag;
  if (bpm < 80 && bestScore > 0.02) bpm *= 2;
  if (bpm > 165) bpm /= 2;

  const confidence = Math.min(1, bestScore / Math.max(1e-9, scoreSum / Math.max(1, maxLag - minLag + 1)));
  return { bpm, confidence };
}

function estimateKey(chroma) {
  const normalized = normalizeArray(chroma);
  let best = { tonic: 0, mode: "major", score: -Infinity };
  const scores = [];

  for (let tonic = 0; tonic < 12; tonic += 1) {
    const major = profileScore(normalized, majorProfile, tonic);
    const minor = profileScore(normalized, minorProfile, tonic);
    scores.push(major, minor);
    if (major > best.score) best = { tonic, mode: "major", score: major };
    if (minor > best.score) best = { tonic, mode: "minor", score: minor };
  }

  const sorted = scores.slice().sort((a, b) => b - a);
  const gap = sorted[0] - (sorted[1] || 0);
  const confidence = clamp(gap / Math.max(0.0001, Math.abs(sorted[0])), 0, 1);
  return {
    name: `${pitchNames[best.tonic]} ${best.mode}`,
    tonic: best.tonic,
    mode: best.mode,
    confidence,
  };
}

function profileScore(chroma, profile, tonic) {
  const rotated = [];
  for (let i = 0; i < 12; i += 1) rotated.push(profile[(i - tonic + 12) % 12]);
  return correlation(chroma, normalizeArray(rotated));
}

function analyzeStereo(buffer) {
  if (buffer.numberOfChannels < 2) {
    return { available: false, correlation: 1, points: [] };
  }

  const left = buffer.getChannelData(0);
  const right = buffer.getChannelData(1);
  const step = Math.max(1, Math.floor(left.length / 2600));
  let sumL2 = 0;
  let sumR2 = 0;
  let sumLR = 0;
  const points = [];

  for (let i = 0; i < left.length; i += step) {
    const l = left[i];
    const r = right[i];
    sumL2 += l * l;
    sumR2 += r * r;
    sumLR += l * r;
    if (points.length < 1500) points.push([l, r]);
  }

  return {
    available: true,
    correlation: sumLR / Math.sqrt(Math.max(1e-12, sumL2 * sumR2)),
    points,
  };
}

function makeProfile(basics, spectral, tempo, stereo) {
  const tags = [];
  const energy = tempo.bpm >= 128 || basics.rmsDb > -14 ? "에너지 높음" : "차분함";
  const tone = spectral.brightness > 0.42 ? "밝은 톤" : spectral.bands.bass + spectral.bands.lowMid > 0.42 ? "따뜻한 톤" : "균형형";
  const dynamics = basics.crestDb > 14 ? "다이내믹" : "밀도 높음";
  const texture = spectral.flatness > 0.16 ? "노이즈 질감" : "톤 중심";
  const width = stereo.available && stereo.correlation < 0.35 ? "넓은 스테레오" : "중앙 집중";

  tags.push(energy, tone, dynamics, texture, width);

  const title = `${tone}의 ${energy.toLowerCase()} 트랙`;
  const bpmText = tempo.bpm ? `${Math.round(tempo.bpm)} BPM` : "템포 불확실";
  const text = `${bpmText}, ${spectral.key.name} 중심으로 추정됩니다. 평균 음량은 ${formatDb(basics.rmsDb)}이고, 스펙트럼 중심은 ${formatHz(spectral.centroid)}입니다.`;
  return { title, text, tags };
}

function renderReport(report) {
  const { file, basics, spectral, tempo, stereo, profile } = report;

  els.durationValue.textContent = formatTime(basics.duration);
  els.bpmValue.textContent = tempo.bpm ? Math.round(tempo.bpm) : "--";
  els.keyValue.textContent = spectral.key.name;
  els.rmsValue.textContent = formatDb(basics.rmsDb);
  els.peakValue.textContent = formatDb(basics.peakDb);
  els.brightnessValue.textContent = labelBrightness(spectral.brightness);
  els.waveformMeta.textContent = `Peak ${formatDb(basics.peakDb)} / RMS ${formatDb(basics.rmsDb)}`;
  els.keyConfidence.textContent = `Confidence ${Math.round(spectral.key.confidence * 100)}%`;
  els.loudnessMeta.textContent = `Crest ${formatDb(basics.crestDb)}`;
  els.stereoMeta.textContent = stereo.available ? `Correlation ${stereo.correlation.toFixed(2)}` : "Mono source";
  els.profileTitle.textContent = profile.title;
  els.profileText.textContent = profile.text;
  els.tagRow.innerHTML = profile.tags.map((tag) => `<span class="tag">${tag}</span>`).join("");

  renderDetails(file, basics, spectral, tempo, stereo);
  drawHeroStatic(report);
  drawWaveform(els.waveformCanvas, report.waveform);
  drawSpectrum(els.spectrumCanvas, spectral.averageMag, spectral.sampleRate, spectral.fftSize);
  drawChroma(els.chromaCanvas, spectral.chroma, spectral.key);
  drawSpectrogram(els.spectrogramCanvas, spectral.spectrogram);
  drawLoudness(els.loudnessCanvas, report.loudness);
  drawStereo(els.stereoCanvas, stereo);
}

function renderDetails(file, basics, spectral, tempo, stereo) {
  els.fileDetails.innerHTML = detailRows([
    ["파일명", file.name],
    ["형식", file.type],
    ["크기", formatBytes(file.size)],
    ["예상 비트레이트", `${Math.round(file.estimatedBitrate)} kbps`],
    ["샘플레이트", `${basics.sampleRate.toLocaleString()} Hz`],
    ["채널", basics.channels],
  ]);

  els.mixDetails.innerHTML = detailRows([
    ["RMS", formatDb(basics.rmsDb)],
    ["Peak", formatDb(basics.peakDb)],
    ["Crest factor", formatDb(basics.crestDb)],
    ["클리핑", `${basics.clippingPercent.toFixed(3)}%`],
    ["무음 비율", `${basics.silencePercent.toFixed(1)}%`],
    ["제로 크로싱", basics.zeroCrossingRate.toFixed(4)],
    ["스펙트럼 중심", formatHz(spectral.centroid)],
    ["롤오프", formatHz(spectral.rolloff)],
    ["BPM 신뢰도", `${Math.round(tempo.confidence * 100)}%`],
    ["스테레오 상관", stereo.available ? stereo.correlation.toFixed(3) : "mono"],
  ]);

  const labels = [
    ["sub", "Sub"],
    ["bass", "Bass"],
    ["lowMid", "Low mid"],
    ["mid", "Mid"],
    ["highMid", "High mid"],
    ["air", "Air"],
  ];

  els.bandList.innerHTML = labels
    .map(([key, label]) => {
      const value = spectral.bands[key] || 0;
      return `<div class="band-row"><span>${label}</span><div class="band-meter"><div class="band-fill" style="width:${Math.round(value * 100)}%"></div></div><strong>${Math.round(value * 100)}%</strong></div>`;
    })
    .join("");
}

function detailRows(rows) {
  return rows
    .map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`)
    .join("");
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => {
    const entities = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[char];
  });
}

async function ensureVisualizer() {
  if (!visualContext) visualContext = new AudioContext();
  if (visualContext.state === "suspended") await visualContext.resume();
  if (!mediaSource) {
    mediaSource = visualContext.createMediaElementSource(els.audioPlayer);
    analyser = visualContext.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.78;
    mediaSource.connect(analyser);
    analyser.connect(visualContext.destination);
  }
}

function animateHero() {
  if (!analyser) return;
  const canvas = els.heroCanvas;
  const ctx = canvas.getContext("2d");
  const freq = new Uint8Array(analyser.frequencyBinCount);
  const time = new Uint8Array(analyser.fftSize);

  const draw = () => {
    analyser.getByteFrequencyData(freq);
    analyser.getByteTimeDomainData(time);
    paintHero(ctx, canvas, freq, time);
    animationId = requestAnimationFrame(draw);
  };

  cancelAnimationFrame(animationId);
  draw();
}

function paintHero(ctx, canvas, freq, time) {
  const { width, height } = canvas;
  ctx.clearRect(0, 0, width, height);
  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, "#15212a");
  gradient.addColorStop(0.52, "#203844");
  gradient.addColorStop(1, "#3c2526");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
  drawGrid(ctx, width, height);

  const centerY = height * 0.52;
  ctx.lineWidth = 3;
  ctx.strokeStyle = colors.teal;
  ctx.beginPath();
  for (let i = 0; i < time.length; i += 1) {
    const x = (i / (time.length - 1)) * width;
    const y = centerY + ((time[i] - 128) / 128) * height * 0.26;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  const bars = 96;
  const barWidth = width / bars;
  for (let i = 0; i < bars; i += 1) {
    const start = Math.floor((i / bars) * freq.length);
    const end = Math.floor(((i + 1) / bars) * freq.length);
    let value = 0;
    for (let j = start; j < end; j += 1) value = Math.max(value, freq[j]);
    const normalized = value / 255;
    const h = normalized * height * 0.42;
    ctx.fillStyle = colorScale(normalized);
    ctx.fillRect(i * barWidth + 2, height - h - 18, Math.max(2, barWidth - 4), h);
  }
}

function drawHeroStatic(report) {
  const canvas = els.heroCanvas;
  const ctx = canvas.getContext("2d");
  const fakeFreq = new Uint8Array(1024);
  const fakeTime = new Uint8Array(2048);

  report.spectral.averageMag.forEach((value, index) => {
    if (index < fakeFreq.length) fakeFreq[index] = clamp(Math.log10(value * 3000 + 1) * 92, 0, 255);
  });

  report.waveform.forEach((point, index) => {
    const target = Math.floor((index / report.waveform.length) * fakeTime.length);
    fakeTime[target] = clamp(128 + point.max * 120, 0, 255);
  });

  for (let i = 0; i < fakeTime.length; i += 1) {
    if (!fakeTime[i]) fakeTime[i] = 128;
  }

  paintHero(ctx, canvas, fakeFreq, fakeTime);
}

function drawWaveform(canvas, waveform) {
  const ctx = setupCanvas(canvas);
  const { width, height } = canvas;
  drawGrid(ctx, width, height);
  const mid = height / 2;
  const xScale = width / waveform.length;

  ctx.fillStyle = "rgba(64, 196, 184, 0.18)";
  ctx.beginPath();
  waveform.forEach((point, i) => {
    const x = i * xScale;
    const y = mid - point.rms * height * 0.42;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  for (let i = waveform.length - 1; i >= 0; i -= 1) {
    const point = waveform[i];
    ctx.lineTo(i * xScale, mid + point.rms * height * 0.42);
  }
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = colors.teal;
  ctx.lineWidth = 1.3;
  waveform.forEach((point, i) => {
    const x = i * xScale;
    ctx.beginPath();
    ctx.moveTo(x, mid + point.min * height * 0.44);
    ctx.lineTo(x, mid + point.max * height * 0.44);
    ctx.stroke();
  });

  labelAxis(ctx, "0:00", 18, height - 18);
}

function drawSpectrum(canvas, magnitudes, sampleRate, fftSize) {
  const ctx = setupCanvas(canvas);
  const { width, height } = canvas;
  drawGrid(ctx, width, height);
  const max = Math.max(...magnitudes);
  const points = [];

  for (let x = 0; x < width; x += 1) {
    const ratio = x / Math.max(1, width - 1);
    const freq = 20 * (1000 ** ratio);
    const bin = Math.min(magnitudes.length - 1, Math.round((freq * fftSize) / sampleRate));
    const value = Math.log10((magnitudes[bin] / Math.max(1e-12, max)) * 9 + 1);
    const y = height - 30 - value * (height - 64);
    points.push([x, y]);
  }

  const fill = ctx.createLinearGradient(0, 24, 0, height - 30);
  fill.addColorStop(0, "rgba(255, 115, 93, 0.42)");
  fill.addColorStop(0.5, "rgba(240, 178, 62, 0.26)");
  fill.addColorStop(1, "rgba(64, 196, 184, 0.08)");
  ctx.beginPath();
  points.forEach(([x, y], index) => {
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.lineTo(width, height - 30);
  ctx.lineTo(0, height - 30);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();

  ctx.strokeStyle = colors.amber;
  ctx.lineWidth = 2;
  ctx.beginPath();
  points.forEach(([x, y], index) => {
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  ["20", "100", "1k", "10k", "20k"].forEach((label, index) => {
    labelAxis(ctx, label, 16 + (index / 4) * (width - 48), height - 12);
  });
}

function drawChroma(canvas, chroma, key) {
  const ctx = setupCanvas(canvas);
  const { width, height } = canvas;
  drawGrid(ctx, width, height);
  const gap = 8;
  const barWidth = (width - 44 - gap * 11) / 12;
  const max = Math.max(...chroma, 0.0001);

  chroma.forEach((value, index) => {
    const normalized = value / max;
    const h = normalized * (height - 82);
    const x = 22 + index * (barWidth + gap);
    const y = height - 42 - h;
    ctx.fillStyle = index === key.tonic ? colors.coral : colorScale(normalized);
    ctx.fillRect(x, y, barWidth, h);
    labelAxis(ctx, pitchNames[index], x + barWidth / 2 - 7, height - 16);
  });
}

function drawSpectrogram(canvas, spectrogram) {
  const ctx = setupCanvas(canvas);
  const { width, height } = canvas;
  const { data, maxValue, rows, columns } = spectrogram;
  const cellWidth = width / columns;
  const cellHeight = height / rows;
  ctx.fillStyle = colors.bg;
  ctx.fillRect(0, 0, width, height);

  for (let col = 0; col < columns; col += 1) {
    const column = data[col];
    for (let row = 0; row < rows; row += 1) {
      const value = Math.log10((column[row] / maxValue) * 18 + 1);
      ctx.fillStyle = colorScale(value);
      ctx.fillRect(col * cellWidth, height - (row + 1) * cellHeight, Math.ceil(cellWidth), Math.ceil(cellHeight));
    }
  }
}

function drawLoudness(canvas, loudness) {
  const ctx = setupCanvas(canvas);
  const { width, height } = canvas;
  drawGrid(ctx, width, height);
  const minDb = -60;
  const maxDb = 0;
  const xScale = width / Math.max(1, loudness.length - 1);

  ctx.strokeStyle = colors.green;
  ctx.lineWidth = 2;
  ctx.beginPath();
  loudness.forEach((point, index) => {
    const x = index * xScale;
    const y = map(point.rmsDb, minDb, maxDb, height - 28, 24);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  ctx.strokeStyle = "rgba(255, 115, 93, 0.6)";
  ctx.beginPath();
  loudness.forEach((point, index) => {
    const x = index * xScale;
    const y = map(point.peakDb, minDb, maxDb, height - 28, 24);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  labelAxis(ctx, "-60 dB", 14, height - 18);
  labelAxis(ctx, "0 dB", 14, 24);
}

function drawStereo(canvas, stereo) {
  const ctx = setupCanvas(canvas);
  const { width, height } = canvas;
  drawGrid(ctx, width, height);
  const cx = width / 2;
  const cy = height / 2;
  const radius = Math.min(width, height) * 0.38;

  ctx.strokeStyle = "rgba(255,255,255,0.16)";
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.moveTo(cx - radius, cy);
  ctx.lineTo(cx + radius, cy);
  ctx.moveTo(cx, cy - radius);
  ctx.lineTo(cx, cy + radius);
  ctx.stroke();

  if (!stereo.available) {
    labelAxis(ctx, "Mono", cx - 20, cy);
    return;
  }

  ctx.fillStyle = "rgba(64, 196, 184, 0.42)";
  stereo.points.forEach(([left, right]) => {
    const mid = (left + right) * 0.5;
    const side = (left - right) * 0.5;
    const x = cx + side * radius * 1.9;
    const y = cy - mid * radius * 1.9;
    ctx.fillRect(x, y, 2, 2);
  });
}

function drawIdle() {
  [els.heroCanvas, els.waveformCanvas, els.spectrumCanvas, els.spectrogramCanvas, els.loudnessCanvas, els.chromaCanvas, els.stereoCanvas].forEach((canvas) => {
    const ctx = setupCanvas(canvas);
    drawGrid(ctx, canvas.width, canvas.height);
  });

  const ctx = els.heroCanvas.getContext("2d");
  ctx.fillStyle = colors.ink;
  ctx.font = "700 34px system-ui";
  ctx.fillText("Sonic Lens", 42, 72);
  ctx.fillStyle = colors.muted;
  ctx.font = "500 18px system-ui";
  ctx.fillText("오디오를 업로드하면 시각화가 시작됩니다.", 42, 108);
}

function setupCanvas(canvas) {
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = colors.bg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  return ctx;
}

function drawGrid(ctx, width, height) {
  ctx.strokeStyle = colors.grid;
  ctx.lineWidth = 1;
  for (let x = 0; x <= width; x += width / 8) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
  for (let y = 0; y <= height; y += height / 5) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }
}

function labelAxis(ctx, text, x, y) {
  ctx.fillStyle = colors.muted;
  ctx.font = "600 13px system-ui";
  ctx.fillText(text, x, y);
}

function colorScale(value) {
  const v = clamp(value, 0, 1);
  if (v < 0.36) return mixColor("#172128", "#40c4b8", v / 0.36);
  if (v < 0.72) return mixColor("#40c4b8", "#f0b23e", (v - 0.36) / 0.36);
  return mixColor("#f0b23e", "#ff735d", (v - 0.72) / 0.28);
}

function mixColor(a, b, amount) {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  const r = Math.round(ca.r + (cb.r - ca.r) * amount);
  const g = Math.round(ca.g + (cb.g - ca.g) * amount);
  const bl = Math.round(ca.b + (cb.b - ca.b) * amount);
  return `rgb(${r}, ${g}, ${bl})`;
}

function hexToRgb(hex) {
  const value = hex.replace("#", "");
  return {
    r: parseInt(value.slice(0, 2), 16),
    g: parseInt(value.slice(2, 4), 16),
    b: parseInt(value.slice(4, 6), 16),
  };
}

function fft(real, imag) {
  // 브라우저 안에서 직접 실행하는 radix-2 FFT 구현이다.
  // 스펙트럼, 스펙트로그램, 키 추정처럼 주파수 영역이 필요한 모든 분석의 기반으로 쓰인다.
  const n = real.length;
  let j = 0;
  for (let i = 1; i < n; i += 1) {
    let bit = n >> 1;
    while (j & bit) {
      j ^= bit;
      bit >>= 1;
    }
    j ^= bit;
    if (i < j) {
      [real[i], real[j]] = [real[j], real[i]];
      [imag[i], imag[j]] = [imag[j], imag[i]];
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    const wLenR = Math.cos(angle);
    const wLenI = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let wr = 1;
      let wi = 0;
      for (let k = 0; k < len / 2; k += 1) {
        const evenR = real[i + k];
        const evenI = imag[i + k];
        const oddR = real[i + k + len / 2] * wr - imag[i + k + len / 2] * wi;
        const oddI = real[i + k + len / 2] * wi + imag[i + k + len / 2] * wr;

        real[i + k] = evenR + oddR;
        imag[i + k] = evenI + oddI;
        real[i + k + len / 2] = evenR - oddR;
        imag[i + k + len / 2] = evenI - oddI;

        const nextWr = wr * wLenR - wi * wLenI;
        wi = wr * wLenI + wi * wLenR;
        wr = nextWr;
      }
    }
  }
}

function normalizeArray(values) {
  const array = Array.from(values);
  const sum = array.reduce((total, value) => total + Math.max(0, value), 0);
  if (sum <= 0) return array.map(() => 0);
  return array.map((value) => Math.max(0, value) / sum);
}

function correlation(a, b) {
  const avgA = a.reduce((sum, value) => sum + value, 0) / a.length;
  const avgB = b.reduce((sum, value) => sum + value, 0) / b.length;
  let numerator = 0;
  let denA = 0;
  let denB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const da = a[i] - avgA;
    const db = b[i] - avgB;
    numerator += da * db;
    denA += da * da;
    denB += db * db;
  }
  return numerator / Math.sqrt(Math.max(1e-12, denA * denB));
}

function setStatus(text) {
  els.statusText.textContent = text;
}

function exportReport() {
  if (!latestReport) return;
  const payload = JSON.stringify(latestReport, null, 2);
  const blob = new Blob([payload], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${latestReport.file.name.replace(/\.[^.]+$/, "")}-sonic-lens-report.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function resetApp() {
  cancelAnimationFrame(animationId);
  resetAudioUrl();
  latestReport = null;
  els.fileInput.value = "";
  els.audioPlayer.removeAttribute("src");
  els.audioPlayer.load();
  els.exportButton.disabled = true;
  els.clearButton.disabled = true;
  els.fileNameValue.textContent = "No file";
  els.durationValue.textContent = "--:--";
  els.bpmValue.textContent = "--";
  els.keyValue.textContent = "--";
  els.rmsValue.textContent = "-- dB";
  els.peakValue.textContent = "-- dB";
  els.brightnessValue.textContent = "--";
  els.profileTitle.textContent = "분석 준비 완료";
  els.profileText.textContent = "파일을 업로드하면 사운드 성향과 믹스 상태를 요약합니다.";
  els.tagRow.innerHTML = "";
  els.fileDetails.innerHTML = "";
  els.mixDetails.innerHTML = "";
  els.bandList.innerHTML = "";
  setStatus("파일 대기 중");
  drawIdle();
}

function resetAudioUrl() {
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = null;
}

function toDb(value) {
  return 20 * Math.log10(Math.max(1e-9, value));
}

function formatDb(value) {
  if (!Number.isFinite(value)) return "-- dB";
  return `${value.toFixed(1)} dB`;
}

function formatHz(value) {
  if (!Number.isFinite(value)) return "-- Hz";
  if (value >= 1000) return `${(value / 1000).toFixed(2)} kHz`;
  return `${Math.round(value)} Hz`;
}

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}

function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return "--:--";
  const minutes = Math.floor(seconds / 60);
  const sec = Math.floor(seconds % 60);
  return `${minutes}:${String(sec).padStart(2, "0")}`;
}

function labelBrightness(value) {
  if (!Number.isFinite(value)) return "--";
  if (value > 0.55) return "밝음";
  if (value < 0.24) return "따뜻함";
  return "균형";
}

function map(value, inMin, inMax, outMin, outMax) {
  const ratio = clamp((value - inMin) / (inMax - inMin), 0, 1);
  return outMin + (outMax - outMin) * ratio;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}
