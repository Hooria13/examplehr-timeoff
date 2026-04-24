import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { Actor, ActorGuard, RequireRole } from './actor.guard';
import { DecisionDto, SubmitRequestDto, TimeOffRequestDto } from './dto';
import { TimeOffService } from './time-off.service';

@Controller('time-off/requests')
@UseGuards(ActorGuard)
export class TimeOffController {
  constructor(private readonly svc: TimeOffService) {}

  @Post()
  submit(
    @Body() body: SubmitRequestDto,
    @Req() req: Request & { actor: Actor },
  ): Promise<TimeOffRequestDto> {
    return this.svc.submit(body, req.actor.userId);
  }

  @Get(':id')
  get(@Param('id') id: string): Promise<TimeOffRequestDto> {
    return this.svc.getById(id);
  }

  @Get()
  list(@Query('employeeId') employeeId: string): Promise<TimeOffRequestDto[]> {
    return this.svc.listByEmployee(employeeId);
  }

  @Post(':id/approve')
  @RequireRole('manager', 'admin')
  approve(
    @Param('id') id: string,
    @Body() body: DecisionDto,
    @Req() req: Request & { actor: Actor },
  ): Promise<TimeOffRequestDto> {
    return this.svc.approve(id, req.actor.userId, body.notes);
  }

  @Post(':id/reject')
  @RequireRole('manager', 'admin')
  reject(
    @Param('id') id: string,
    @Body() body: DecisionDto,
    @Req() req: Request & { actor: Actor },
  ): Promise<TimeOffRequestDto> {
    return this.svc.reject(id, req.actor.userId, body.notes);
  }

  @Post(':id/cancel')
  cancel(
    @Param('id') id: string,
    @Req() req: Request & { actor: Actor },
  ): Promise<TimeOffRequestDto> {
    return this.svc.cancel(id, req.actor.userId);
  }
}
