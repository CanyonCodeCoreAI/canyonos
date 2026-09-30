const required = (key: string, value: string | undefined): string => {
  if (!value) throw new Error(`Missing required env: VITE_${key}`);
  return value;
};

export const webEnv = {
  api: {
    baseUrl: required('API_URL', import.meta.env.VITE_API_URL),
  },
  app: {
    name: 'Canyon Code',
    isProduction: import.meta.env.PROD,
    isDevelopment: import.meta.env.DEV,
  },
};
