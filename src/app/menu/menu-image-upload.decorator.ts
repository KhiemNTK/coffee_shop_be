import {
  applyDecorators,
  BadRequestException,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import {
  MENU_IMAGE_MAX_BYTES,
  MENU_IMAGE_MIME_TYPES,
} from '../../common/consts/menu-images';

export const MenuImageUpload = () =>
  applyDecorators(
    Throttle({ default: { limit: 8, ttl: 60_000 } }),
    ApiConsumes('multipart/form-data'),
    ApiBody({
      required: true,
      schema: {
        type: 'object',
        required: ['file'],
        properties: { file: { type: 'string', format: 'binary' } },
      },
    }),
    UseInterceptors(
      FileInterceptor('file', {
        limits: {
          fileSize: MENU_IMAGE_MAX_BYTES,
          files: 1,
          fields: 0,
          parts: 2,
        },
        fileFilter: (_req, file, done) => {
          if (!MENU_IMAGE_MIME_TYPES.some((mime) => mime === file.mimetype)) {
            return done(
              new BadRequestException({
                code: 'IMAGE_UPLOAD_INVALID',
                message: 'Only JPEG, PNG and WebP images are supported.',
              }),
              false,
            );
          }
          done(null, true);
        },
      }),
    ),
  );
