import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtModule } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { StringUtilService } from '../../common/utils/string-util/string-util.service';
import { EmployeesModule } from '../employees/employees.module';
import { JWTEnvs } from './consts/jwt.const';
import { MailUtilModule } from '../../common/utils/mail-util/mail-util.module';
import { AuthorizationModule } from '../authorization/authorization.module';
import { AuthTokenService } from './auth-token.service';
import { AuthSessionService } from './auth-session.service';
import { PasswordResetService } from './password-reset.service';
@Module({
  imports: [
    AuthorizationModule,
    EmployeesModule,
    MailUtilModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        global: true,
        secret: configService.get<string>(JWTEnvs.JWT_SECRET),
      }),
    }),
  ],
  providers: [
    AuthService,
    AuthTokenService,
    AuthSessionService,
    PasswordResetService,
    StringUtilService,
  ],
  exports: [AuthService, AuthSessionService],
  controllers: [AuthController],
})
export class AuthModule {}
