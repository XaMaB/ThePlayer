// moq-lite-06 groups are sequence numbers in origin-cmaf-v1, not timestamps.
// Estimate a bounded cache window from each track's newest complete fragment.
export function cachedStartPlan(video, audio, reserve = 4) {
  if (!video?.timing || !audio?.timing)
    throw new Error('Cannot measure cached media timing');
  const cadence = video.timing.duration;
  const liveEnd = Math.min(video.timing.end, audio.timing.end);
  // Keep a whole delivery cycle above the desired minimum reserve.
  const desiredStart = liveEnd - reserve - cadence;
  function from(sample) {
    const duration = sample.timing.duration;
    if (!(duration > 0 && Number.isFinite(duration)))
      throw new Error('Invalid fragment duration');
    const back = BigInt(
      Math.min(
        512,
        Math.max(
          0,
          Math.ceil((sample.timing.end - desiredStart) / duration) - 1,
        ),
      ),
    );
    return sample.group > back ? sample.group - back : 1n;
  }
  const historyAvailable = [video, audio].every(
    (s) =>
      s.group >= BigInt(Math.ceil((reserve + cadence) / s.timing.duration)),
  );
  return {
    video: from(video),
    audio: from(audio),
    liveEnd,
    desiredStart,
    reserve,
    cadence,
    historyAvailable,
  };
}
