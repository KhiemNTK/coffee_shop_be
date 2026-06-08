import { SetMetadata } from '@nestjs/common';

export const IS_SKIP_AUTH = 'IS_SKIP_AUTH';

export const SkipAuth = () => SetMetadata(IS_SKIP_AUTH, true);
