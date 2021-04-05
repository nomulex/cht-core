import { Injectable } from '@angular/core';
import { DbService } from '../db.service';

@Injectable({
  providedIn: 'root'
})
export class MutingTransition {
  constructor(
    private dbService:DbService,
  ) { }


};
