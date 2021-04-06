export interface Transition {
  name:string;
  init(Object):void;
  filter(Object):boolean;
  onMatch(Object):Promise<any>;
}
