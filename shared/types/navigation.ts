export interface NavigationItem {
  label: string;
  path: string;
  icon: string;
  description?: string;
  group?: string;
  permission?: string;
}

export interface PlaceholderPage {
  title: string;
  eyebrow: string;
  description: string;
}