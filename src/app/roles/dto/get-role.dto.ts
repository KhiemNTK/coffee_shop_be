import { Pagination } from '../../../common/utils/pagination-util/pagination-util.interface';
import { ExportExcelDto } from '../../../common/dto/param.dto';

class GetRolesPaginationDto extends Pagination {}

class ExportRolesDto extends ExportExcelDto {}

export { GetRolesPaginationDto, ExportRolesDto };
