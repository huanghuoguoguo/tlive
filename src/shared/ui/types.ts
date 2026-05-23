export interface Button {
  label: string;
  callbackData: string;
  style?: 'primary' | 'danger' | 'default';
  /** URL button: opens link directly instead of sending callback */
  url?: string;
  /** Row index for layout grouping. Buttons with same row are on one line. */
  row?: number;
}
