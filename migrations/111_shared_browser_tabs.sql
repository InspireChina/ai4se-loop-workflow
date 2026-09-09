-- Browser automation now shares one Chrome instance across per-Agent tabs.
-- Remove the retired global mutex while retaining the resource key in code so
-- historical execution snapshots remain readable.
DELETE FROM resource_claims
WHERE resource_key = 'browser:exclusive';
