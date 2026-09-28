const AGY_ENVIRONMENT_ALLOWLIST = [
	"HOME",
	"USERPROFILE",
	"APPDATA",
	"LOCALAPPDATA",
	"PATH",
	"TMPDIR",
	"TEMP",
	"TMP",
	"LANG",
	"LC_ALL",
	"TERM",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"XDG_CACHE_HOME",
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"NO_PROXY",
	"SSL_CERT_FILE",
	"NODE_EXTRA_CA_CERTS",
	"SYSTEMROOT",
] as const;

export function agyChildEnvironment(parent: Record<string, string | undefined> = process.env): Record<string, string> {
	const environment: Record<string, string> = {};
	for (const name of AGY_ENVIRONMENT_ALLOWLIST) {
		const value = parent[name];
		if (value !== undefined) environment[name] = value;
	}
	return environment;
}
