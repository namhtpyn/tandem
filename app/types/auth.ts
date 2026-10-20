export type AuthConfig = {
  passwordEnabled: boolean;
  oidcEnabled: boolean;
  providers: Array<{ id: string; label: string }>;
  companyName?: string;
};
