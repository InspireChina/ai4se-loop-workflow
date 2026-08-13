UPDATE tasks
SET priority = CASE upper(trim(COALESCE(priority, '')))
  WHEN 'P0' THEN '9'
  WHEN 'S0' THEN '9'
  WHEN 'P1' THEN '9'
  WHEN 'S1' THEN '9'
  WHEN 'P2' THEN '5'
  WHEN 'S2' THEN '5'
  WHEN 'P3' THEN '1'
  WHEN 'S3' THEN '1'
  WHEN '' THEN '5'
  ELSE priority
END;
