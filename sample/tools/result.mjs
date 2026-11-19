export async function waitForImage(project, getResult, { timeout, checkAfter = 90_000, retryAfter = 30_000, progressDelay = 3_000 }) {
  let deadline, check, checking = false, settled = false, reachedFullProgress = false, retryNotBefore = 0;
  let onProgress, onJobCompleted;
  const result = new Promise((resolve, reject) => {
    const scheduleCheck = (delay) => {
      clearTimeout(check);
      check = setTimeout(recover, Math.min(timeout, Math.max(delay, retryNotBefore - Date.now())));
    };
    const recover = async () => {
      if (checking || settled) return;
      checking = true;
      let status;
      try {
        status = await getResult();
      } catch (error) {
        if (Number.isFinite(error?.retryAfter) && error.retryAfter > 0) {
          retryNotBefore = Date.now() + error.retryAfter * 1_000;
        }
      } finally {
        checking = false;
      }
      if (settled) return;
      const url = status?.jobs.find((job) => job.status === "completed" && job.url)?.url;
      if (url) return resolve(url);
      if (status?.status === "failed" || status?.status === "canceled") {
        return reject(new Error(status.failure?.message ?? `project ${status.status}`));
      }
      scheduleCheck(retryAfter);
    };

    deadline = setTimeout(() => reject(new Error("timeout")), timeout);
    scheduleCheck(checkAfter);
    onProgress = (progress) => {
      if (progress < 100 || reachedFullProgress) return;
      reachedFullProgress = true;
      if (!checking) scheduleCheck(progressDelay);
    };
    project.on("progress", onProgress);
    onProgress(project.progress);
    onJobCompleted = (job) => {
      if (job.resultUrl) resolve(job.resultUrl);
    };
    project.on("jobCompleted", onJobCompleted);
    if (project.resultUrls[0]) resolve(project.resultUrls[0]);
    project.waitForCompletion().then(([url]) => {
      if (settled) return;
      if (url) resolve(url);
      else if (!checking) scheduleCheck(0);
    }, reject);
  });

  try {
    return await result;
  } finally {
    settled = true;
    clearTimeout(deadline);
    clearTimeout(check);
    project.off("progress", onProgress);
    project.off("jobCompleted", onJobCompleted);
  }
}
