<template>
  <div class="member-list" v-if="constants.length">
    <h2 id="constants">
      <a href="#constants" class="header-anchor">#</a> Constants
    </h2>

    <template v-for="(constant, index) in constants">
      <div class="member-header">
        <h4 :id="constant.name.toLowerCase()">
          <a :href="`#${constant.name.toLowerCase()}`" class="header-anchor">#</a> {{constant.name}} <Badge v-if="constant.deprecated" text="DEPRECATED" type="warn"/>
        </h4>
        <AvailabilityInfo :platforms="constant.platforms"/>
      </div>
      <DeprecationAlert :deprecated="constant.deprecated"/>
      <p v-html="constant.summary"></p>
      <p v-html="constant.description"></p>
      <hr v-if="index < constants.length - 1">
    </template>
  </div>
</template>

<script>
import AvailabilityInfo from './AvailabilityInfo';
import DeprecationAlert from './DeprecationAlert';

export default {
  components: {
    AvailabilityInfo,
    DeprecationAlert
  },
  props: {
    constants: {
      type: Array,
      default: () => []
    }
  }
}
</script>