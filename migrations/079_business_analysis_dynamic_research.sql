ALTER TABLE execution_attempts
ADD COLUMN web_search_enabled INTEGER NOT NULL DEFAULT 0
CHECK(web_search_enabled IN (0, 1));

ALTER TABLE business_analysis_drafts
ADD COLUMN research_enabled INTEGER NOT NULL DEFAULT 0
CHECK(research_enabled IN (0, 1));
