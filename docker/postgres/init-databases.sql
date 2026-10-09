-- Runs once, on first start of an empty Postgres volume (docker-entrypoint-initdb.d).
-- video_creation (campaigns MVP) is created by POSTGRES_DB; the studio needs its own databases.
CREATE DATABASE video_studio;
CREATE DATABASE video_studio_test;
