import { SetMetadata } from '@nestjs/common';

export const IS_SKIP_CSRF = 'IS_SKIP_CSRF';

export const SkipCsrf = () => SetMetadata(IS_SKIP_CSRF, true);
