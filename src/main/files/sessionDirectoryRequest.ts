import { relative } from "node:path";
import type { ProjectDirectoryRequest } from "../../shared/types/projectFiles";
import type { ProjectFileTarget } from "../../shared/types/project";
import { createProjectFileReadBoundary, resolveProjectFileReadPath } from "./projectFileAccess";
import { parseProjectFileTarget, resolveLocalProjectFileTarget } from "./projectFileTarget";

export type FileSessionRecord = { projectId: string; workspacePath?: string };

/** Directory reads alone may carry a session identity; mutation targets remain project-relative. */
export function parseProjectDirectoryRequest(value: unknown): ProjectDirectoryRequest {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("INVALID_PROJECT_FILE_TARGET");
	const sessionId = "sessionId" in value ? value.sessionId : undefined;
	const target = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "sessionId"));
	const parsed = parseProjectFileTarget(target);
	if (sessionId === undefined) return parsed;
	if (typeof sessionId !== "string" || !sessionId.trim() || sessionId !== sessionId.trim() || sessionId.length > 256 || sessionId.includes("\0")) throw new Error("INVALID_PROJECT_FILE_TARGET");
	return { ...parsed, sessionId };
}

/** Resolve catalog-owned roots, then check both project and session containment through realpath. */
export async function resolveSessionDirectory(request: ProjectDirectoryRequest, projectRoot: string, getSession?: (id: string) => FileSessionRecord | undefined): Promise<{ target: ProjectFileTarget; root: string }> {
	const projectBoundary = await createProjectFileReadBoundary(projectRoot);
	if (request.sessionId === undefined) return { target: request, root: projectBoundary.canonicalRoot };
	const record = getSession?.(request.sessionId);
	if (!record || record.projectId !== request.projectId) throw new Error("INVALID_PROJECT_FILE_TARGET");
	const root = record.workspacePath ? await resolveProjectFileReadPath(projectBoundary, record.workspacePath) : projectBoundary.canonicalRoot;
	const sessionBoundary = await createProjectFileReadBoundary(root);
	const requestedPath = request.relativePath === "" ? root : resolveLocalProjectFileTarget(projectBoundary.canonicalRoot, request.relativePath);
	const canonicalPath = await resolveProjectFileReadPath(sessionBoundary, requestedPath);
	return { target: { projectId: request.projectId, relativePath: relative(projectBoundary.canonicalRoot, canonicalPath).replace(/\\/g, "/") }, root };
}
