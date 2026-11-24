\getenv harbor_password HARBOR_DB_PASSWORD
CREATE ROLE harbor LOGIN PASSWORD :'harbor_password';
ALTER DATABASE harbor OWNER TO harbor;
