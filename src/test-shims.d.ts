/**
 * Type shim for @vue/test-utils v1 with <script setup> components.
 *
 * test-utils v1's mount() returns Wrapper<Vue>, which can't infer types from
 * <script setup> components. This shim adds permissive overloads so that
 * wrapper.vm.property accesses don't produce TS errors.
 *
 * REMOVE THIS FILE when upgrading to @vue/test-utils v2 + Vue 3.
 */
export {};

declare module "@vue/test-utils" {
  export function mount(component: any, options?: any): any;
  export function shallowMount(component: any, options?: any): any;
}
