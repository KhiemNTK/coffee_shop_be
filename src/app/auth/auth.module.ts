import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { JwtModule } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { StringUtilService } from '../../common/utils/string-util/string-util.service';
import { EmployeesModule } from '../employees/employees.module';
import { JWTEnvs } from './consts/jwt.const';
import { MailUtilService } from '../../common/utils/mail-util/mail-util.service';
import { AuthorizationModule } from '../authorization/authorization.module';
@Module({
  imports: [
    AuthorizationModule,
    EmployeesModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        global: true,
        secret: configService.get<string>(JWTEnvs.JWT_SECRET),
      }),
    }),
  ],
  providers: [AuthService, StringUtilService, MailUtilService],
  exports: [AuthService],
  controllers: [AuthController],
})
export class AuthModule {}
