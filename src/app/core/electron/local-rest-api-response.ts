import { LocalRestApiResponsePayload } from '../../../../electron/shared-with-frontend/local-rest-api.model';

export type LocalRestApiQuery = Record<string, string | string[]>;

export const getQueryParam = (
  query: LocalRestApiQuery,
  key: string,
): string | undefined => {
  const value = query[key];
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : value;
};

export const getQueryParamAsBoolean = (
  query: LocalRestApiQuery,
  key: string,
  defaultValue: boolean,
): boolean => {
  const value = getQueryParam(query, key);
  if (value === undefined) return defaultValue;
  return value.toLowerCase() === 'true';
};

export const createErrorResponse = (
  requestId: string,
  status: number,
  code: string,
  message: string,
  details?: unknown,
): LocalRestApiResponsePayload => ({
  requestId,
  status,
  body: {
    ok: false,
    error: {
      code,
      message,
      details,
    },
  },
});

export const createSuccessResponse = (
  requestId: string,
  status: number,
  data: unknown,
): LocalRestApiResponsePayload => ({
  requestId,
  status,
  body: {
    ok: true,
    data,
  },
});
