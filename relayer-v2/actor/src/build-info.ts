// ABOUTME: Reports the git commit the running image was built from, surfaced at /health so
// ABOUTME: operators can confirm which build is deployed without inspecting image digests.

/**
 * The commit SHA baked into the image at build time (Dockerfile `ARG GIT_SHA`), or "unknown"
 * for local runs where it is unset. Read at call time so tests can vary it.
 */
export function deployedCommit(): string {
  return process.env.GIT_SHA || "unknown";
}
