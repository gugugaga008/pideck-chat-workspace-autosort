import type { ProjectServices, ProjectServicesApi } from "../../services/projectServiceContracts";
import { unwrapOp, PROJECT_SERVICE_CODES } from "../../services/projectServiceContracts";
import type { ProjectDirectoryRequest } from "../../../../shared/types/projectFiles";

/** Bind directory and name-search reads to a catalog session, preserving project-relative entry identities. */
export function sessionDirectoryServices(services: ProjectServices, api: ProjectServicesApi, sessionId: string, workspacePath?: string): ProjectServices {
	return {
		...services,
		generation: `${services.generation}:session:${sessionId}:${workspacePath ?? ""}`,
		capabilities: { ...services.capabilities, files: { ...services.capabilities.files, contentSearch: false } },
		files: {
			...services.files,
			async listDirectory(target, options) {
				if (target.projectId !== services.projectId) throw new Error("INVALID_PROJECT_FILE_TARGET");
				const request: ProjectDirectoryRequest = { ...target, sessionId };
				return unwrapOp(await api.files.directoryPage(request, options), PROJECT_SERVICE_CODES.failed);
			},
			async searchFiles(query) {
				const request: ProjectDirectoryRequest = { projectId: services.projectId, relativePath: "", sessionId };
				return unwrapOp(await api.files.searchPage(request, query), PROJECT_SERVICE_CODES.failed);
			},
			async searchContent() {
				return null;
			},
		},
	};
}

/** Relative links follow the live runtime, then the persisted workspace, then the project. */
export function sessionFileBaseDir(runtimeCwd?: string, workspacePath?: string, projectPath?: string): string | undefined {
	return runtimeCwd ?? workspacePath ?? projectPath;
}
