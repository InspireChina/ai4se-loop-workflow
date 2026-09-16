export type VerificationArtifactManifest = {
  directory: string;
  entries: { path: string; kind: 'file' | 'directory'; mode: number; size: number; sha256: string }[];
};
